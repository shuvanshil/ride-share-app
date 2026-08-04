# LiphtUp

A local, mobile-first ride-booking platform for passengers and drivers in Tripura, India.

LiphtUp combines a static web app, a FastAPI backend, Firebase/Firestore services, Google Maps integration, and web notifications to support local ride requests from booking through completion. The project is designed as a lightweight PWA rather than a large-scale global ride-share platform.

## Overview

LiphtUp enables:

- Passengers to choose a pickup and destination, request a ride, receive a fare estimate, track the assigned driver, verify a pickup PIN, and review trip history.
- Approved drivers to go online, receive matching ride requests, accept or decline rides, update trip status, and view driver-focused dashboard metrics.
- Operators to review safety-related alerts and reports through the included admin console.

## Key features

- Ride booking with location-aware pickup/drop selection
- Shared fare policy for bike and auto rides
- Live ride tracking and ride-state updates
- OTP-based verification and password reset flows
- Firebase Cloud Messaging for ride notifications
- Driver availability, ride acceptance, and trip lifecycle handling
- Driver dashboard metrics and ride decline tracking
- Passenger safety tools such as SOS reporting, trip sharing, and emergency contacts
- PWA support with offline fallback and installability

## Tech stack

- Frontend: static HTML, CSS, and vanilla JavaScript ES modules
- Styling: Bootstrap-based responsive UI
- Backend: Python 3 with FastAPI
- Authentication and data: Firebase Authentication, Cloud Firestore, and Firebase Admin SDK
- Maps and routing: Google Maps JavaScript API plus server-side geocoding/route helpers
- Notifications: Firebase Cloud Messaging
- Hosting: Vercel-style deployment with the web app rooted at the www directory

## Architecture and how it works

The project is split between a browser-based frontend and a server-side API layer:

1. The frontend in the www directory renders the passenger and driver experiences, manages map interactions, and listens to Firestore updates.
2. The FastAPI app in www/api handles protected business logic, ride transitions, authentication checks, provider integrations, and server-authoritative writes.
3. Firestore stores ride data, user profiles, driver presence, trip history, and safety-related records.
4. Google Maps and Firebase services provide location, authentication, real-time updates, and push notifications.

This keeps the app lightweight while still enforcing important ride operations on the backend rather than trusting the browser alone.

## Project structure

```text
www/                 Frontend PWA and static pages
www/api/             FastAPI application and API routers
www/js/              Browser-side JavaScript modules
www/css/             Stylesheets
www/admin/           Admin console assets
docs/                Project context and Firestore documentation
firestore.rules      Firestore access rules
firestore.indexes.json Firestore indexes
```

## Setup and installation

Prerequisites:

- Python 3
- Access to Firebase, Google Maps, and 2Factor credentials for the runtime environment

Steps:

1. Clone the repository.
2. Install the Python dependencies from www/requirements.txt.
3. Configure the required environment variables.
4. Run the FastAPI app locally from the www directory.

Example local API run:

```bash
cd www
pip install -r requirements.txt
uvicorn api.index:app --reload --port 3000
```

The frontend is a static web app and is intended to be served from the www directory as the project root.

## Environment variables

The backend expects the following environment variables.

Required:

- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- GOOGLE_MAPS_BROWSER_KEY
- GOOGLE_MAPS_SERVER_KEY
- TWOFACTOR_API_KEY
- OTP_SESSION_SECRET

Optional:

- FIREBASE_WEB_API_KEY
- TWOFACTOR_OTP_TEMPLATE
- PUBLIC_APP_URL
- APP_BASE_URL

Do not commit secrets or real service-account values.

## Running locally

- Start the API with Uvicorn from the www directory.
- Serve the static frontend files from the www directory in a local web server or deploy environment.
- The app is designed around a Vercel-style layout, so deployment and local serving should preserve the relative API paths under /api.

## Deployment

The repository is built for deployment as a Vercel project with the www directory as the web root.

Recommended deployment steps:

1. Deploy the contents of www as the project root.
2. Configure the environment variables in the hosting platform.
3. Ensure Firestore rules and indexes are deployed for the latest features.

## Current status

LiphtUp is currently a functional MVP-style ride-booking application with a strong focus on local use cases and security-conscious backend logic.

### Completed

- Passenger ride booking and tracking
- Driver availability and ride acceptance flow
- OTP-based authentication and password reset
- Trip history and basic profile management
- Driver dashboard metrics
- Ride decline tracking
- Passenger safety tooling and admin safety visibility

### In progress / needs verification

- Production deployment validation
- Firestore rules/index deployment confirmation for newer features
- FCM and provider integration verification
- End-to-end browser smoke testing and real-world operational checks

### Planned

- Full admin driver-review workflow
- Real payment gateway integration
- Broader monitoring, logging, and alerting
- Additional concurrency, reconnect, and stale-driver resilience testing

## Roadmap

Near-term priorities include tightening production readiness, validating deployed integrations, and expanding operational tooling while keeping the app lightweight and local-first.

## Contributing

Contributions are welcome. Please keep changes scoped, preserve the existing API response conventions, and update related tests or documentation where appropriate. Backend tests live under the www/api/tests directory.

## Additional documentation

- [docs/ai-project-context.md](docs/ai-project-context.md)
- [docs/firestore-indexes.md](docs/firestore-indexes.md)

## License

No license file is currently present in this repository.
