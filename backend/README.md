# PlanningVoyage API

Node.js 22+, Express, MySQL, JWT, Firebase Admin Messaging and PDFKit.

## 1. Install
```powershell
cd C:\reactnative\PlanningVoyage\backend
npm install
Copy-Item .env.example .env
```

Edit `.env` with the MySQL credentials and a JWT secret of at least 32 characters.

## 2. Create the MySQL database
Import `database/schema.sql` from the repository root using phpMyAdmin or MySQL:
```powershell
mysql -u root -p < ..\database\schema.sql
```
Create a dedicated MySQL user and grant it access only to the `planningvoyage` database. Put those credentials in `.env`.

## 3. Configure Firebase
In Firebase Console, create/select the Android project and obtain a Firebase Admin service-account JSON from Project settings > Service accounts. Encode the JSON file as Base64 and put the result in `FIREBASE_SERVICE_ACCOUNT_BASE64`. Never commit the JSON or its private key.

PowerShell encoding:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\service-account.json"))
```

## 4. Create the first administrator
```powershell
npm run create-admin
```
The script asks for a name, email and password (minimum 12 characters). It stores only a bcrypt hash.

## 5. Run
```powershell
npm run dev
```
Health check: `http://localhost:5000/api/health`

## Main endpoints
- `POST /api/auth/login`
- `GET /api/me`
- `POST /api/me/change-password`
- `POST /api/me/device-token`
- `GET /api/me/trips`
- `GET /api/me/history.pdf`
- `GET /api/me/notifications`
- `PATCH /api/me/notifications/:id/read`
- `POST /api/admin/users`
- `GET /api/admin/users`
- `POST /api/admin/trips`
- `PUT /api/admin/trips/:id`
- `GET /api/admin/trips`
- `POST /api/admin/notifications`

All admin routes require a JWT whose role is `admin`. Traveler endpoints derive the user ID from the verified JWT; they never accept a target user ID from the app.

## Important
- Keep `.env`, Firebase service-account JSON and production secrets out of Git.
- Use HTTPS in production.
- Set `CORS_ORIGIN` to the exact admin-web origin before deployment.
- Configure Android Firebase Messaging in the mobile project as well as this server.
- The API currently provides the backend foundation; the admin web interface and the single-file mobile UI are the next implementation stages.
