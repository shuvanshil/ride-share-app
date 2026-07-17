"""
Google Maps endpoints. Direct port of:
  google-config.js, google-autocomplete.js, google-place-detail.js,
  google-reverse-geocode.js, google-route.js
"""
from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, Query

from ..core.errors import ApiError
from ..core.google_client import (
    fetch_json,
    get_google_config,
    number_or_null,
    require_server_key,
)

router = APIRouter()

DEFAULT_LAT = 23.8315
DEFAULT_LNG = 91.9882

TRIPURA_TOWNS_RE = re.compile(
    r"(agartala|kailashahar|kumarghat|dharmanagar|ambassa|udaipur|belonia|khowai|teliamura|unakoti|tripura)"
)


# ---------------------------------------------------------------------------
# GET /api/google-config
# ---------------------------------------------------------------------------
@router.get("/google-config")
async def google_config() -> dict[str, Any]:
    browser_key = get_google_config()["browserKey"]
    if not browser_key:
        raise ApiError("Missing GOOGLE_MAPS_BROWSER_KEY.", 500)
    return {"browserKey": browser_key}


# ---------------------------------------------------------------------------
# GET /api/google-autocomplete
# ---------------------------------------------------------------------------
def _build_query_variants(query: str) -> list[str]:
    clean = re.sub(r"\s+", " ", (query or "").strip())
    lower = clean.lower()
    variants = [clean, f"{clean} Tripura", f"{clean} India"]

    if not TRIPURA_TOWNS_RE.search(lower):
        variants.append(f"{clean} Kailashahar Tripura")
        variants.append(f"{clean} Unakoti Tripura")
        variants.append(f"{clean} Agartala Tripura")

    seen: set[str] = set()
    unique: list[str] = []
    for v in variants:
        if v and v not in seen:
            seen.add(v)
            unique.append(v)
    return unique[:6]


def _normalize_prediction(prediction: dict[str, Any]) -> dict[str, Any]:
    structured = prediction.get("structuredFormat") or {}
    main_text = (structured.get("mainText") or {}).get("text") or (prediction.get("text") or {}).get("text") or ""
    secondary_text = (structured.get("secondaryText") or {}).get("text") or (prediction.get("text") or {}).get("text") or ""

    return {
        "placeId": prediction.get("placeId") or "",
        "name": main_text or secondary_text,
        "mainName": main_text or secondary_text,
        "fullAddress": secondary_text or main_text,
        "types": prediction.get("types") if isinstance(prediction.get("types"), list) else [],
        "lat": None,
        "lng": None,
        "source": "google",
        "provider": "google",
    }


def _normalize_text_search_place(place: dict[str, Any]) -> dict[str, Any]:
    location = place.get("location") or {}
    lat = number_or_null(location.get("latitude"))
    lng = number_or_null(location.get("longitude"))
    main_name = (place.get("displayName") or {}).get("text") or place.get("formattedAddress") or ""

    return {
        "placeId": place.get("id") or "",
        "name": main_name,
        "mainName": main_name,
        "fullAddress": place.get("formattedAddress") or "",
        "types": place.get("types") if isinstance(place.get("types"), list) else [],
        "lat": lat,
        "lng": lng,
        "source": "google",
        "provider": "google",
    }


async def _fetch_autocomplete(input_text: str, key: str, lat: Optional[float], lng: Optional[float]) -> list[dict[str, Any]]:
    body = {
        "input": input_text,
        "includedRegionCodes": ["in"],
        "includeQueryPredictions": False,
        "locationBias": {
            "circle": {
                "center": {
                    "latitude": lat if lat is not None else DEFAULT_LAT,
                    "longitude": lng if lng is not None else DEFAULT_LNG,
                },
                "radius": 50000,
            }
        },
    }
    data = await fetch_json(
        "https://places.googleapis.com/v1/places:autocomplete",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
        },
        json_body=body,
    )
    suggestions = data.get("suggestions") if isinstance(data.get("suggestions"), list) else []
    predictions = [s.get("placePrediction") for s in suggestions if s.get("placePrediction")]
    return [_normalize_prediction(p) for p in predictions]


async def _fetch_text_search(input_text: str, key: str, lat: Optional[float], lng: Optional[float]) -> list[dict[str, Any]]:
    body = {
        "textQuery": input_text,
        "regionCode": "IN",
        "locationBias": {
            "circle": {
                "center": {
                    "latitude": lat if lat is not None else DEFAULT_LAT,
                    "longitude": lng if lng is not None else DEFAULT_LNG,
                },
                "radius": 50000,
            }
        },
    }
    data = await fetch_json(
        "https://places.googleapis.com/v1/places:searchText",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types",
        },
        json_body=body,
    )
    places = data.get("places") if isinstance(data.get("places"), list) else []
    return [_normalize_text_search_place(p) for p in places]


def _is_meaningful_label(value: Optional[str]) -> bool:
    trimmed = (value or "").strip()
    if not trimmed:
        return False
    return not re.match(r"^\d+[a-zA-Z]?$", trimmed)


async def _fetch_geocode(input_text: str, key: str) -> list[dict[str, Any]]:
    params = f"address={quote(input_text)}&region=in&key={quote(key)}"
    data = await fetch_json(f"https://maps.googleapis.com/maps/api/geocode/json?{params}")
    results = data.get("results") if isinstance(data.get("results"), list) else []

    output = []
    for item in results:
        location = (item.get("geometry") or {}).get("location") or {}
        full_address = item.get("formatted_address") or ""
        components = item.get("address_components") or []
        first_meaningful = next(
            (c.get("long_name") for c in components if _is_meaningful_label(c.get("long_name"))),
            None,
        )
        main_name = first_meaningful or full_address

        output.append(
            {
                "placeId": item.get("place_id") or "",
                "name": main_name,
                "mainName": main_name,
                "fullAddress": full_address,
                "types": item.get("types") if isinstance(item.get("types"), list) else [],
                "lat": number_or_null(location.get("lat")),
                "lng": number_or_null(location.get("lng")),
                "source": "google",
                "provider": "google",
            }
        )
    return output


async def _collect_safe(label: str, debug: list[dict[str, Any]], task) -> list[dict[str, Any]]:
    try:
        results = await task()
        debug.append({"label": label, "ok": True, "count": len(results)})
        return results
    except ApiError as error:
        upstream = error.extra.get("upstreamData") or {}
        message = (
            (upstream.get("error") or {}).get("message")
            if isinstance(upstream.get("error"), dict)
            else upstream.get("error_message")
        ) or error.message
        debug.append(
            {
                "label": label,
                "ok": False,
                "status": error.status_code or 0,
                "message": message,
            }
        )
        return []


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    output = []
    for item in items:
        key = "|".join(
            [
                str(item.get("placeId") or "").lower(),
                str(item.get("mainName") or item.get("name") or "").lower(),
                str(item.get("fullAddress") or "").lower(),
            ]
        )
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


@router.get("/google-autocomplete")
async def google_autocomplete(
    q: str = Query(""),
    lat: Optional[str] = Query(None),
    lng: Optional[str] = Query(None),
    debug: Optional[str] = Query(None),
) -> dict[str, Any]:
    query = (q or "").strip()
    if len(query) < 2:
        return {"results": []}

    lat_num = number_or_null(lat)
    lng_num = number_or_null(lng)

    try:
        key = require_server_key()
        debug_entries: list[dict[str, Any]] = []
        results: list[dict[str, Any]] = []

        for variant in _build_query_variants(query):
            results.extend(await _collect_safe(f"autocomplete:{variant}", debug_entries, lambda v=variant: _fetch_autocomplete(v, key, lat_num, lng_num)))
            if len(results) >= 8:
                break

            results.extend(await _collect_safe(f"text:{variant}", debug_entries, lambda v=variant: _fetch_text_search(v, key, lat_num, lng_num)))
            if len(results) >= 8:
                break

            results.extend(await _collect_safe(f"geocode:{variant}", debug_entries, lambda v=variant: _fetch_geocode(v, key)))
            if len(results) >= 8:
                break

        payload: dict[str, Any] = {"results": _dedupe(results)[:8]}
        if debug == "1":
            payload["debug"] = debug_entries
        return payload
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001 - mirror the catch-all in the original handler
        raise ApiError("Google autocomplete failed", 500)


# ---------------------------------------------------------------------------
# GET /api/google-place-detail
# ---------------------------------------------------------------------------
def _normalize_place(place: dict[str, Any]) -> dict[str, Any]:
    location = place.get("location") or {}
    lat = number_or_null(location.get("latitude", location.get("lat")))
    lng = number_or_null(location.get("longitude", location.get("lng")))
    display_name = (place.get("displayName") or {}).get("text") or place.get("name") or ""

    return {
        "placeId": str(place.get("id") or "").strip(),
        "name": display_name,
        "mainName": display_name,
        "fullAddress": place.get("formattedAddress") or "",
        "lat": lat,
        "lng": lng,
        "types": place.get("types") if isinstance(place.get("types"), list) else [],
        "typeHint": "",
        "source": "google",
        "provider": "google",
    }


@router.get("/google-place-detail")
async def google_place_detail(placeId: str = Query("")) -> dict[str, Any]:  # noqa: N803 - matches querystring name
    place_id = (placeId or "").strip()
    if not place_id:
        raise ApiError("Missing placeId", 400)

    try:
        key = require_server_key()
        url = f"https://places.googleapis.com/v1/places/{quote(place_id, safe='')}"
        data = await fetch_json(
            url,
            headers={
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "id,displayName,formattedAddress,location,types",
            },
        )
        result = _normalize_place(data)

        if result["lat"] is None or result["lng"] is None:
            raise ApiError("Place location not found", 404)

        return {"result": result}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Google place detail failed", 500)


# ---------------------------------------------------------------------------
# GET /api/google-reverse-geocode
# ---------------------------------------------------------------------------
_PLUS_CODE_RE = re.compile(r"^[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,3}\s*,?\s*", re.IGNORECASE)


def _get_component(components: list[dict[str, Any]], type_: str) -> str:
    for component in components:
        if type_ in (component.get("types") or []):
            return component.get("long_name") or ""
    return ""


def _compact_parts(parts: list[str]) -> list[str]:
    seen: set[str] = set()
    output = []
    for part in parts:
        trimmed = (part or "").strip()
        if not trimmed:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(trimmed)
    return output


def _strip_plus_code(value: str) -> str:
    return _PLUS_CODE_RE.sub("", value or "").strip()


def _build_detailed_address(item: dict[str, Any]) -> dict[str, str]:
    components = item.get("address_components") or []

    premise_raw = (
        _get_component(components, "premise")
        or _get_component(components, "point_of_interest")
        or _get_component(components, "establishment")
        or _get_component(components, "sublocality_level_3")
    )
    road_raw = _get_component(components, "route")
    locality_raw = (
        _get_component(components, "sublocality_level_2")
        or _get_component(components, "sublocality_level_1")
        or _get_component(components, "neighborhood")
    )
    city_raw = (
        _get_component(components, "locality")
        or _get_component(components, "postal_town")
        or _get_component(components, "administrative_area_level_3")
    )
    district = _get_component(components, "administrative_area_level_2")
    state = _get_component(components, "administrative_area_level_1")
    pin_code = _get_component(components, "postal_code")
    formatted = _strip_plus_code(item.get("formatted_address") or "")

    premise = premise_raw if _is_meaningful_label(premise_raw) else ""
    road = road_raw if _is_meaningful_label(road_raw) else ""
    locality = locality_raw if _is_meaningful_label(locality_raw) else ""
    city = city_raw if _is_meaningful_label(city_raw) else ""

    area = premise or road or locality
    if area and city and area.lower() != city.lower():
        name = f"{area}, {city}"
    else:
        name = city or area or formatted or "Pinned location"

    return {
        "name": name,
        "displayAddress": ", ".join(_compact_parts([premise, road, locality, city, district, state, pin_code])) or formatted,
        "landmark": premise,
        "road": road,
        "locality": locality,
        "city": city,
        "district": district,
        "state": state,
        "pinCode": pin_code,
    }


def _pick_best_result(results: list[dict[str, Any]]):
    candidates = [{"item": item, "details": _build_detailed_address(item)} for item in results[:5]]
    for candidate in candidates:
        if _is_meaningful_label(candidate["details"]["name"]):
            return candidate
    return candidates[0] if candidates else None


@router.get("/google-reverse-geocode")
async def google_reverse_geocode(lat: Optional[str] = Query(None), lng: Optional[str] = Query(None)) -> dict[str, Any]:
    lat_num = number_or_null(lat)
    lng_num = number_or_null(lng)
    if lat_num is None or lng_num is None:
        raise ApiError("Missing lat/lng", 400)

    try:
        key = require_server_key()
        params = f"latlng={lat_num},{lng_num}&key={quote(key)}"
        data = await fetch_json(f"https://maps.googleapis.com/maps/api/geocode/json?{params}")
        results = data.get("results") if isinstance(data.get("results"), list) else []
        best = _pick_best_result(results)

        if not best:
            raise ApiError("Address not found", 404)

        item = best["item"]
        details = best["details"]

        return {
            "result": {
                "name": details["name"],
                "fullAddress": item.get("formatted_address") or "",
                "displayAddress": details["displayAddress"],
                "landmark": details["landmark"],
                "road": details["road"],
                "locality": details["locality"],
                "city": details["city"],
                "district": details["district"],
                "state": details["state"],
                "pinCode": details["pinCode"],
                "placeId": item.get("place_id") or "",
                "lat": lat_num,
                "lng": lng_num,
                "source": "google",
                "provider": "google",
            }
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Google reverse geocode failed", 500)


# ---------------------------------------------------------------------------
# GET /api/google-route
# ---------------------------------------------------------------------------
_DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)s$")


def _parse_duration_seconds(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return value
    match = _DURATION_RE.match(str(value or ""))
    return float(match.group(1)) if match else None


@router.get("/google-route")
async def google_route(
    originLat: Optional[str] = Query(None),  # noqa: N803
    originLng: Optional[str] = Query(None),  # noqa: N803
    destinationLat: Optional[str] = Query(None),  # noqa: N803
    destinationLng: Optional[str] = Query(None),  # noqa: N803
) -> dict[str, Any]:
    origin_lat = number_or_null(originLat)
    origin_lng = number_or_null(originLng)
    destination_lat = number_or_null(destinationLat)
    destination_lng = number_or_null(destinationLng)

    if origin_lat is None or origin_lng is None or destination_lat is None or destination_lng is None:
        raise ApiError("Missing route coordinates", 400)

    try:
        key = require_server_key()
        data = await fetch_json(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
            },
            json_body={
                "origin": {"location": {"latLng": {"latitude": origin_lat, "longitude": origin_lng}}},
                "destination": {"location": {"latLng": {"latitude": destination_lat, "longitude": destination_lng}}},
                "travelMode": "DRIVE",
                "routingPreference": "TRAFFIC_UNAWARE",
                "computeAlternativeRoutes": False,
                "units": "METRIC",
            },
        )

        routes = data.get("routes") if isinstance(data.get("routes"), list) else []
        route = routes[0] if routes else None
        if not route:
            raise ApiError("Google route not found", 404)

        distance_meters = number_or_null(route.get("distanceMeters"))
        duration_seconds = _parse_duration_seconds((route.get("duration")))

        return {
            "distanceKm": (distance_meters / 1000) if distance_meters is not None else None,
            "durationMinutes": max(1, round(duration_seconds / 60)) if duration_seconds is not None else None,
            "encodedPolyline": (route.get("polyline") or {}).get("encodedPolyline") or "",
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Google route failed", 500)
