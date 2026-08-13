# Implementation Plan - UI Improvements and Profile Fix

This plan covers UI enhancements to the passenger services page and resolving the profile update issue where `updatedAt` is causing a 400 error.

## User Review Required

> [!IMPORTANT]
> I will be using the image assets provided in the chat. Since they are not yet in the project filesystem, I will assume the following paths:
> - `assets/icons/swap-icon.png` (for the swap button)
> - `assets/vehicle-markers/bike-marker.png` (updated with the new bike icon)
> - `assets/vehicle-markers/auto-marker.png` (updated with the new auto icon)
>
> Please ensure these files are uploaded to these locations if you want the app to display them correctly.

## Proposed Changes

### Core Logic

#### [MODIFY] [profile.js](file:///C:/Users/theto/ride-share-app/android/app/src/main/assets/public/js/core/profile.js)
- Remove `updatedAt: serverTimestamp()` from the `updates` object in the `saveProfile` function. The backend appears to handle this field automatically or forbids it in the request payload.

### UI Components

#### [MODIFY] [services.html](file:///C:/Users/theto/ride-share-app/android/app/src/main/assets/public/services.html)
- Add a swap button between/beside the pickup and destination fields.
- Improve the layout of the location input card to match the mockup.
- Update the "Choose your ride" section to use the new icons and a more modern list design.

#### [MODIFY] [style.css](file:///C:/Users/theto/ride-share-app/android/app/src/main/assets/public/css/style.css)
- Add styles for the swap button and improved location fields.
- Refine the ride service cards (bike/auto) with better padding, shadows, and alignment.
- Apply overall design tweaks to the services page for a cleaner look.

## Verification Plan

### Automated Tests
- I'll check for any syntax errors in the modified JavaScript and CSS files.

### Manual Verification
- Deploy the app to the device and verify the UI changes on the services page.
- Test the profile update functionality to ensure the 400 error is resolved.
