# Implementation Plan - Bug Fixes and UI Enhancements

This plan addresses several UI issues and functional bugs in the passenger services and home pages, as requested.

## Proposed Changes

### 1. Fix Swap Locations Functionality
The swap functionality in `services.js` is not updating the `currentPickup` state in `services.js`, which prevents subsequent swaps from working correctly. We will update `map.js` to dispatch a `pickup-location-updated` event when a swap occurs.

#### [MODIFY] [map.js](file:///C:/Users/theto/ride-share-app/www/js/core/map.js)
- Update the `locations-swapped` event listener to dispatch a `pickup-location-updated` event. This ensures all components (like `services.js`) update their internal state for the new pickup location.

### 2. Remove Redundant "Select drop on map" Button
There are two "Select drop on map" buttons. We will remove the default one shown below the location fields in `services.html` and keep only the one that appears in the suggestions dropdown.

#### [MODIFY] [services.html](file:///C:/Users/theto/ride-share-app/www/services.html)
- Remove the `<button id="select-on-map-btn">` element.

### 3. Remove "Pay with cash" Card
The "Pay with cash" card below the vehicle options will be removed.

#### [MODIFY] [services.html](file:///C:/Users/theto/ride-share-app/www/services.html)
- Remove the `div` with class `payment-method-selector`.

### 4. Fix Missing Edit Icon for Saved Places
The edit icon for saved home/work addresses is not showing because its parent container is not a positioned element, causing the absolute positioning of the icon to fail.

#### [MODIFY] [style.css](file:///C:/Users/theto/ride-share-app/www/css/style.css)
- Add `position: relative;` to the `.dashboard-saved-chip-wrap` class.

### 5. Deployment
After all changes are applied, the changes will be pushed to the `deployment` branch on GitHub.

## Verification Plan

### Manual Verification
- **Swap Fix**: Open the services page, enter a pickup and destination, and click the swap button multiple times. Verify that the locations swap correctly each time and the fare is recalculated.
- **Button Removal**: Verify that the "Select drop on map" button below the destination field is gone, but the one in the search suggestions still appears.
- **Payment Card Removal**: Verify that the "Pay with cash" card is no longer visible below the vehicle selection.
- **Edit Icon Fix**: Verify that the edit icon (pencil) is visible on the home/work address chips on the home page when an address is set.

### Deployment Verification
- Verify that changes are successfully pushed to the `deployment` branch.
