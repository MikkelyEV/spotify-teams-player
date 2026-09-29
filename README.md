# SOTD v2
Shared Song of the Day app for a Microsoft Teams group chat.

## Features
- Multiple Spotify tracks per day.
- One track per Teams user per Central-Time day.
- Shows who submitted each track and the Central-Time submission time.
- Refreshes every 30 seconds.
- Timer cleanup runs at 06:00 UTC, which equals midnight CST. Note: during daylight saving time, Central midnight is 05:00 UTC; use two timer checks or a separate scheduler if exact America/Chicago midnight year-round is required.

## Architecture
- Azure Static Web Apps hosts index.html.
- A separate Azure Function App hosts /api/songs and the timer cleanup.
- Azure Table Storage stores the shared daily list.

## Required configuration
1. Create an Azure Storage Account.
2. Create a Function App using Node.js 20 or later.
3. Add Function App setting AZURE_STORAGE_CONNECTION_STRING.
4. Deploy the api folder to the Function App.
5. Link the existing Function App to the Azure Static Web App as its API backend.
6. Replace the existing repository root files with this package and push to main.

## Identity/security note
The one-song limit uses the Teams user ID supplied by TeamsJS. The API in this starter does not cryptographically validate a Teams SSO token. For a tamper-resistant production deployment, add Teams SSO and validate the Entra token in the API before trusting userId/userName.
