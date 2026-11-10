# PlanningVoyage

Système de gestion des déplacements d'un bureau : application Android personnelle, portail Web administrateur et API Node.js/MySQL.

## Fonctionnement
1. Le voyageur communique ses dates au bureau hors application (téléphone, email ou en personne).
2. L'administrateur crée le compte voyageur et enregistre le déplacement depuis `admin/index.html`.
3. L'API conserve les informations dans MySQL et crée une notification liée à ce voyageur.
4. Firebase Cloud Messaging envoie le push uniquement aux appareils enregistrés sur ce compte.
5. L'application Android affiche l'historique passé et le prochain voyage, les notifications et le PDF personnel.

## Structure
- `App.js` : interface Android complète dans un seul fichier JavaScript.
- `admin/index.html` : portail Web administrateur autonome (HTML/CSS/JS dans un fichier).
- `backend/server.js` : API Node.js, JWT, MySQL, Firebase Messaging, PDF.
- `backend/create-admin.js` : création du premier administrateur.
- `backend/.env.example` : modèle des variables serveur.
- `database/schema.sql` : schéma MySQL.

## Démarrage du backend
Consultez [backend/README.md](backend/README.md). En bref :
```powershell
cd backend
npm install
Copy-Item .env.example .env
# Compléter .env, importer database/schema.sql depuis la racine du dépôt
npm run create-admin
npm run dev
```

## Android
1. Dans Firebase Console, créez un projet Firebase et ajoutez une application Android avec l'identifiant `com.planningvoyage`.
2. Téléchargez `google-services.json` et placez-le dans `android/app/google-services.json`. Ne publiez jamais ce fichier dans un dépôt public.
3. Dans `App.js`, remplacez `API_BASE_URL` par l'URL HTTPS de votre API en production. Pour l'émulateur Android local, `http://10.0.2.2:5000/api` pointe vers le PC.
4. Installez les dépendances :
```powershell
npm install
```
5. Compilez après configuration Firebase :
```powershell
cd android
.\\gradlew clean
.\\gradlew assembleDebug
```

Pour un téléphone physique en développement, utilisez l'adresse IP LAN du PC au lieu de `10.0.2.2`. En production, utilisez obligatoirement HTTPS. Configurez également une vraie clé de signature Android avant toute publication Play Store.

## Portail Web administrateur
Déployez `admin/index.html` sur un hébergement HTTPS. Dans l'écran de connexion, indiquez l'URL de l'API terminant par `/api`. Définissez `CORS_ORIGIN` dans le backend avec l'origine exacte du portail.

## Sécurité
- Les mots de passe sont stockés sous forme de hash bcrypt.
- Les sessions utilisent JWT.
- Les routes d'administration vérifient le rôle admin.
- Les routes voyageur dérivent l'identifiant du compte depuis le JWT ; l'application ne peut pas choisir l'identifiant d'un autre voyageur.
- Les secrets Firebase, MySQL et JWT restent uniquement dans le fichier `.env` du serveur et ne doivent jamais être commités.
- Le compte administrateur initial est créé par le script CLI, pas par une valeur codée en dur.

## État
La base du serveur, le schéma SQL, l'interface Android initiale et le portail Web administrateur sont ajoutés. Il reste à configurer les identifiants Firebase/MySQL, l'URL réelle de l'API, puis à tester sur un appareil Android et sur l'hébergement cible.
