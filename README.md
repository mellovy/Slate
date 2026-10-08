# Slate (Canvas client)
Pulls your real Canvas courses, assignments, due dates, submission status and grades. Local to-dos can sit alongside them.

## Connect
Canvas > Account > Settings > New Access Token. Paste the token and your school's Canvas address (https://yourschool.instructure.com) into the app.
The token is encrypted with Windows secure storage and only ever sent to that address.

## Build the installer (PowerShell on Windows)
    npm install
    npm run dist
Result: `dist/Slate-Setup.exe`. Test without building: `npm start`.
No Windows machine? Push to GitHub and run the "Build Windows installer" action.
