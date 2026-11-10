'use strict';

// Configurez l'URL de base dans l'écran de connexion.
// Exemple : https://api.votre-domaine.com (sans /api à la fin).
const DEFAULT_API_BASE = window.PLANNINGVOYAGE_API_URL || window.location.origin;

const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem('pv_admin_token') || '', user: null, travelers: [], trips: [] };

function apiBase() {
  return (localStorage.getItem('pv_api_base') || DEFAULT_API_BASE).replace(/\/+$/, '');
}
function setMessage(element, message, success = false) {
  element.textContent = message || '';
  element.classList.toggle('success', !!success);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, { ...options, headers });
  } catch {
    throw new Error("Impossible de joindre l'API. Vérifiez l'adresse du serveur et le réseau.");
  }
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (response.status === 401) {
    logout(false);
    throw new Error(data?.message || 'Session expirée. Veuillez vous reconnecter.');
  }
  if (!response.ok) throw new Error(data?.message || `Erreur HTTP ${response.status}.`);
  if (raw && !data) throw new Error('Le serveur a renvoyé une réponse qui n’est pas au format JSON.');
  return data;
}
function showGlobal(message, error = false) {
  const box = $('#globalMessage');
  box.textContent = message;
  box.className = `global-message show${error ? ' error' : ''}`;
}
function clearGlobal() {
  $('#globalMessage').className = 'global-message';
  $('#globalMessage').textContent = '';
}
function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('fr-FR');
}
function statusLabel(status) {
  return ({ planned: 'Planifié', confirmed: 'Confirmé', completed: 'Terminé', cancelled: 'Annulé' })[status] || status || '—';
}
function statusBadge(status) {
  return `<span class="badge-status status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}
function switchSection(name) {
  document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== `section-${name}`; });
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.section === name));
  $('#pageTitle').textContent = ({ dashboard: 'Tableau de bord', travelers: 'Voyageurs', trips: 'Planning des voyages', notifications: 'Notifications privées' })[name];
  clearGlobal();
}
function logout(showMessage = true) {
  state.token = '';
  state.user = null;
  sessionStorage.removeItem('pv_admin_token');
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  if (showMessage) setMessage($('#loginMessage'), 'Vous êtes déconnecté.', true);
}
function renderTravelerOptions() {
  const options = state.travelers.filter(user => user.isActive).map(user =>
    `<option value="${Number(user.id)}">${escapeHtml(user.fullName)} — ${escapeHtml(user.email)}</option>`
  ).join('');
  ['#tripTraveler', '#notificationTraveler'].forEach(selector => {
    const select = $(selector);
    const previous = select.value;
    select.innerHTML = '<option value="">Sélectionner un voyageur</option>' + options;
    if (previous) select.value = previous;
  });
}
function renderTravelers() {
  const query = $('#travelerSearch').value.trim().toLowerCase();
  const rows = state.travelers.filter(user => `${user.fullName} ${user.email} ${user.phone || ''}`.toLowerCase().includes(query));
  $('#travelerCount').textContent = `${rows.length} voyageur(s)`;
  $('#travelersBody').innerHTML = rows.length ? rows.map(user => `
    <tr><td><strong>${escapeHtml(user.fullName)}</strong></td><td>${escapeHtml(user.email)}</td>
    <td>${escapeHtml(user.phone || '—')}</td><td>${user.isActive ? '<span class="badge-status status-confirmed">Actif</span>' : '<span class="badge-status status-cancelled">Inactif</span>'}</td></tr>
  `).join('') : '<tr><td colspan="4" class="empty">Aucun voyageur trouvé.</td></tr>';
}
function renderTrips() {
  const query = $('#tripSearch').value.trim().toLowerCase();
  const filtered = state.trips.filter(trip => `${trip.travelerName} ${trip.email} ${trip.departureCity} ${trip.destination}`.toLowerCase().includes(query));
  $('#tripsBody').innerHTML = filtered.length ? filtered.map(trip => `
    <tr><td><strong>${escapeHtml(trip.travelerName)}</strong><br><small>${escapeHtml(trip.email)}</small></td>
    <td>${escapeHtml(trip.departureCity)}</td><td>${escapeHtml(trip.destination)}</td>
    <td>${dateLabel(trip.departureDate)}</td><td>${dateLabel(trip.arrivalDate)}</td>
    <td>${statusBadge(trip.status)}</td><td><button class="action-button" data-edit-trip="${Number(trip.id)}">Modifier</button></td></tr>
  `).join('') : '<tr><td colspan="7" class="empty">Aucun voyage trouvé.</td></tr>';
  const recent = [...state.trips].sort((a,b) => String(b.departureDate).localeCompare(String(a.departureDate))).slice(0, 6);
  $('#recentTripsBody').innerHTML = recent.length ? recent.map(trip => `
    <tr><td>${escapeHtml(trip.travelerName)}</td><td>${escapeHtml(trip.departureCity)}</td>
    <td>${escapeHtml(trip.destination)}</td><td>${dateLabel(trip.departureDate)}</td><td>${statusBadge(trip.status)}</td></tr>
  `).join('') : '<tr><td colspan="5" class="empty">Aucun voyage enregistré.</td></tr>';
  $('#statTravelers').textContent = state.travelers.length;
  $('#statTrips').textContent = state.trips.length;
  $('#statConfirmed').textContent = state.trips.filter(t => t.status === 'confirmed').length;
  const today = new Date(); today.setHours(0,0,0,0);
  $('#statUpcoming').textContent = state.trips.filter(t => t.status !== 'cancelled' && new Date(`${String(t.departureDate).slice(0,10)}T00:00:00`) >= today).length;
}
async function loadData() {
  const [travelers, trips] = await Promise.all([api('/api/admin/users'), api('/api/admin/trips')]);
  if (!Array.isArray(travelers) || !Array.isArray(trips)) throw new Error('Format de données inattendu depuis le serveur.');
  state.travelers = travelers;
  state.trips = trips;
  renderTravelerOptions();
  renderTravelers();
  renderTrips();
}
async function enterApp(user) {
  if (user?.role !== 'admin') {
    logout(false);
    throw new Error('Ce compte ne possède pas le rôle administrateur.');
  }
  state.user = user;
  $('#adminName').textContent = user.fullName || 'Administrateur';
  $('#adminEmail').textContent = user.email || '';
  $('#todayLabel').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  await loadData();
  switchSection('dashboard');
}
$('#apiBaseInput').value = localStorage.getItem('pv_api_base') || DEFAULT_API_BASE;
$('#saveApiBase').addEventListener('click', () => {
  const value = $('#apiBaseInput').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+(?::\d+)?$/i.test(value)) {
    setMessage($('#loginMessage'), 'Adresse invalide. Saisissez une origine, par exemple https://api.exemple.com.');
    return;
  }
  localStorage.setItem('pv_api_base', value);
  setMessage($('#loginMessage'), 'Adresse API enregistrée.', true);
});
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage($('#loginMessage'), 'Connexion en cours…');
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value })
    });
    if (!result?.token || !result?.user) throw new Error('Réponse de connexion incomplète.');
    state.token = result.token;
    sessionStorage.setItem('pv_admin_token', result.token);
    await enterApp(result.user);
  } catch (error) {
    setMessage($('#loginMessage'), error.message);
  } finally { button.disabled = false; }
});
$('#logoutButton').addEventListener('click', () => logout());
document.querySelectorAll('.nav-link').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.go)));
$('#refreshButton').addEventListener('click', async () => {
  try { await loadData(); showGlobal('Données actualisées.'); }
  catch (error) { showGlobal(error.message, true); }
});
$('#travelerSearch').addEventListener('input', renderTravelers);
$('#tripSearch').addEventListener('input', renderTrips);

$('#travelerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const message = $('#travelerMessage');
  setMessage(message, 'Création du compte…');
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    await loadData();
    setMessage(message, 'Compte voyageur créé avec succès.', true);
  } catch (error) { setMessage(message, error.message); }
  finally { button.disabled = false; }
});
function resetTripForm() {
  $('#tripForm').reset();
  $('#tripForm').elements.tripId.value = '';
  $('#tripFormTitle').textContent = 'Programmer un voyage';
  $('#tripSubmit').textContent = 'Enregistrer le voyage';
  $('#cancelEdit').hidden = true;
  $('#tripTraveler').disabled = false;
}
$('#cancelEdit').addEventListener('click', resetTripForm);
$('#tripsBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-trip]');
  if (!button) return;
  const trip = state.trips.find(item => Number(item.id) === Number(button.dataset.editTrip));
  if (!trip) return;
  const form = $('#tripForm');
  form.elements.tripId.value = trip.id;
  form.elements.userId.value = trip.userId;
  form.elements.userId.disabled = true;
  form.elements.departureDate.value = String(trip.departureDate || '').slice(0,10);
  form.elements.departureCity.value = trip.departureCity || '';
  form.elements.destination.value = trip.destination || '';
  form.elements.arrivalDate.value = String(trip.arrivalDate || '').slice(0,10);
  form.elements.arrivalCity.value = trip.arrivalCity || '';
  form.elements.status.value = trip.status || 'planned';
  $('#tripFormTitle').textContent = `Modifier le voyage #${trip.id}`;
  $('#tripSubmit').textContent = 'Enregistrer les modifications';
  $('#cancelEdit').hidden = false;
  switchSection('trips');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#tripForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const tripId = data.tripId;
  delete data.tripId;
  if (form.elements.userId.disabled) data.userId = form.elements.userId.value;
  const message = $('#tripMessage');
  setMessage(message, 'Enregistrement…');
  $('#tripSubmit').disabled = true;
  try {
    if (tripId) {
      await api(`/api/admin/trips/${encodeURIComponent(tripId)}`, { method: 'PUT', body: JSON.stringify(data) });
      setMessage(message, 'Voyage mis à jour. Une notification a été créée.', true);
    } else {
      await api('/api/admin/trips', { method: 'POST', body: JSON.stringify(data) });
      setMessage(message, 'Voyage créé. Une notification a été créée.', true);
    }
    resetTripForm();
    await loadData();
  } catch (error) { setMessage(message, error.message); }
  finally { $('#tripSubmit').disabled = false; }
});
$('#notificationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.userId = Number(data.userId);
  const message = $('#notificationMessage');
  setMessage(message, 'Envoi en cours…');
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    const result = await api('/api/admin/notifications', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    const delivery = result?.push?.sent ? 'Notification push envoyée.' : 'Message enregistré. Push non confirmé (vérifiez Firebase et le token de l’appareil).';
    setMessage(message, delivery, true);
  } catch (error) { setMessage(message, error.message); }
  finally { button.disabled = false; }
});

// Reuse a session token only after validating it with the protected /api/me route.
(async function restoreSession() {
  if (!state.token) return;
  try {
    const user = await api('/api/me');
    await enterApp(user);
  } catch (error) {
    logout(false);
    setMessage($('#loginMessage'), error.message || 'Veuillez vous reconnecter.');
  }
})();
