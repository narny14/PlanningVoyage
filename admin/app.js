'use strict';

const DEFAULT_API_BASE = window.PLANNINGVOYAGE_API_URL || window.location.origin;
const $ = selector => document.querySelector(selector);
const state = {
  token: sessionStorage.getItem('pv_admin_token') || '',
  user: null,
  travelers: [],
  trips: [],
  pendingVerifications: []
};

function apiBase() {
  return (localStorage.getItem('pv_api_base') || DEFAULT_API_BASE).replace(/\/+$/, '');
}
function setMessage(element, message, success = false) {
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('success', !!success);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
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
  try { data = raw ? JSON.parse(raw) : null; } catch {}
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
function tripStatusLabel(status) {
  return ({ planned: 'Planifié', confirmed: 'Confirmé', cancelled: 'Annulé' })[status] || status || '—';
}
function boardingLabel(status) {
  return ({ pending: 'En attente de vérification', boarded: 'Embarqué confirmé', not_boarded: 'Non embarqué' })[status] || 'À vérifier';
}
function badge(status, label) {
  return `<span class="badge-status status-${escapeHtml(status || 'pending')}">${escapeHtml(label)}</span>`;
}
function switchSection(name) {
  document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== `section-${name}`; });
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.section === name));
  $('#pageTitle').textContent = ({ dashboard: 'Tableau de bord', travelers: 'Voyageurs', trips: 'Planning et embarquements', notifications: 'Notifications privées' })[name];
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
    <td>${escapeHtml(user.phone || '—')}</td><td>${user.isActive ? badge('confirmed', 'Actif') : badge('cancelled', 'Inactif')}</td></tr>
  `).join('') : '<tr><td colspan="4" class="empty">Aucun voyageur trouvé.</td></tr>';
}
function renderVerificationCard(trip) {
  return `
    <article class="verification-card" id="verification-${Number(trip.id)}">
      <div class="verification-summary">
        <div>
          <strong>${escapeHtml(trip.travelerName || trip.fullName || 'Voyageur')}</strong>
          <p>${escapeHtml(trip.departureCity || '—')} → ${escapeHtml(trip.destination || '—')} · Départ : ${dateLabel(trip.departureDate)}</p>
          <small>${escapeHtml(trip.email || '')} · Voyage #${Number(trip.id)}</small>
        </div>
        ${badge('pending', 'En attente')}
      </div>
      <form class="verification-form" data-verify-trip="${Number(trip.id)}">
        <div class="form-grid">
          <label>Résultat de vérification<select name="boardingStatus" required><option value="boarded">Embarqué</option><option value="not_boarded">Non embarqué</option></select></label>
          <label>Compagnie aérienne<input name="airline" maxlength="150" placeholder="Ex. Congo Airways"></label>
          <label>Numéro de vol<input name="flightNumber" maxlength="80" placeholder="Ex. 8Z…"></label>
          <label>Référence du rapport<input name="flightReportReference" maxlength="120" placeholder="Référence du rapport avion"></label>
          <label>Date réelle de départ<input name="actualDepartureDate" type="date"></label>
          <label>Date réelle d'arrivée<input name="actualArrivalDate" type="date"></label>
          <label class="full-width">Observation<textarea name="observation" rows="2" placeholder="Détail facultatif basé sur le rapport consulté"></textarea></label>
        </div>
        <p class="hint">La validation est définitive dans le flux actuel : vérifiez le rapport de vol avant d'enregistrer.</p>
        <button class="btn btn-primary" type="submit">Enregistrer la vérification</button>
        <p class="message" role="status"></p>
      </form>
    </article>`;
}
function renderVerifications() {
  const list = $('#pendingVerificationList');
  $('#pendingVerificationCount').textContent = `${state.pendingVerifications.length} en attente`;
  list.innerHTML = state.pendingVerifications.length
    ? state.pendingVerifications.map(renderVerificationCard).join('')
    : '<p class="empty">Aucun voyage en attente de vérification.</p>';
}


function renderTrips() {
  const query = $('#tripSearch').value.trim().toLowerCase();

  const filtered = state.trips.filter(trip =>
    `${trip.travelerName || ''} ${trip.email || ''} ${trip.departureCity || ''} ${trip.destination || ''}`
      .toLowerCase()
      .includes(query)
  );

  // Date locale du navigateur, au format YYYY-MM-DD.
  const now = new Date();
  const todayKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  $('#tripsBody').innerHTML = filtered.length
    ? filtered.map(trip => {
        const id = Number(trip.id);
        const status = trip.boardingStatus || 'pending';
        const isCancelled = trip.status === 'cancelled';
        const departureDay = String(trip.departureDate || '').slice(0, 10);
        const isFuture = departureDay > todayKey;

        let verificationAction = '';

        if (isCancelled) {
          verificationAction = `
            <span class="muted">Voyage annulé</span>
          `;
        } else if (status === 'boarded') {
          verificationAction = `
            <span class="status-boarded">
              Embarquement confirmé
            </span>
          `;
        } else if (status === 'not_boarded') {
          verificationAction = `
            <span class="status-not_boarded">
              Non embarqué
            </span>
          `;
        } else {
          verificationAction = `
            <button
              class="btn btn-primary"
              type="button"
              data-open-verification="${id}">
              Confirmer l’embarquement
            </button>

            ${
              isFuture
                ? '<small class="muted">Enregistrement disponible à partir du jour du départ.</small>'
                : '<small class="muted">Vérification autorisée.</small>'
            }
          `;
        }

        const editAction =
          status === 'pending' && !isCancelled
            ? `
              <button
                class="action-button"
                type="button"
                data-edit-trip="${id}">
                Modifier
              </button>
            `
            : '';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(trip.travelerName)}</strong><br>
              <small>${escapeHtml(trip.email)}</small>
            </td>

            <td>${escapeHtml(trip.departureCity)}</td>

            <td>${escapeHtml(trip.destination)}</td>

            <td>${dateLabel(trip.departureDate)}</td>

            <td>
              ${badge(trip.status, tripStatusLabel(trip.status))}
            </td>

            <td>
              ${badge(status, boardingLabel(status))}
            </td>

            <td>
              <div class="trip-actions">
                ${verificationAction}
                ${editAction}
              </div>
            </td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="7" class="empty">Aucun voyage trouvé.</td>
      </tr>
    `;

  // Tableau des voyages récents.
  const recent = [...state.trips]
    .sort((a, b) =>
      String(b.departureDate).localeCompare(String(a.departureDate))
    )
    .slice(0, 6);

  $('#recentTripsBody').innerHTML = recent.length
    ? recent.map(trip => `
        <tr>
          <td>${escapeHtml(trip.travelerName)}</td>
          <td>${escapeHtml(trip.departureCity)}</td>
          <td>${escapeHtml(trip.destination)}</td>
          <td>${dateLabel(trip.departureDate)}</td>
          <td>
            ${badge(trip.status, tripStatusLabel(trip.status))}
          </td>
          <td>
            ${badge(
              trip.boardingStatus || 'pending',
              boardingLabel(trip.boardingStatus)
            )}
          </td>
        </tr>
      `).join('')
    : `
      <tr>
        <td colspan="6" class="empty">Aucun voyage enregistré.</td>
      </tr>
    `;

  // Statistiques.
  $('#statTravelers').textContent = state.travelers.length;
  $('#statTrips').textContent = state.trips.length;

  $('#statConfirmed').textContent =
    state.trips.filter(t => t.boardingStatus === 'boarded').length;

  $('#statUpcoming').textContent = state.trips.filter(trip => {
    const day = String(trip.departureDate || '').slice(0, 10);

    return trip.status !== 'cancelled' && day >= todayKey;
  }).length;
}


async function loadData() {
  const [travelers, trips, pending] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/trips'),
    api('/api/admin/trips/pending-verification')
  ]);
  if (!Array.isArray(travelers) || !Array.isArray(trips) || !Array.isArray(pending)) {
    throw new Error('Format de données inattendu depuis le serveur.');
  }
  state.travelers = travelers;
  state.trips = trips;
  state.pendingVerifications = pending;
  renderTravelerOptions();
  renderTravelers();
  renderTrips();
  renderVerifications();
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
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  setMessage($('#loginMessage'), 'Connexion en cours…');
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
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

$('#travelerForm').addEventListener('submit', async event => {
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

$('#tripsBody').addEventListener('click', event => {
  const verifyButton = event.target.closest('[data-open-verification]');

  if (verifyButton) {
    const tripId = Number(verifyButton.dataset.openVerification);

    // Chercher d'abord la fiche existante
    let card = document.getElementById(`verification-${tripId}`);

    // Si elle n'existe pas, construire la fiche depuis le voyage
    if (!card) {
      const trip = state.trips.find(
        item => Number(item.id) === tripId
      );

      if (!trip) {
        showGlobal('Voyage introuvable. Actualisez les données.', true);
        return;
      }

      // Ne pas permettre la vérification d'un voyage annulé
      if (trip.status === 'cancelled') {
        showGlobal('Un voyage annulé ne peut pas être vérifié.', true);
        return;
      }

      const container = $('#pendingVerificationList');

      const empty = container.querySelector('.empty');
      if (empty) empty.remove();

      const temporaryCard = document.createElement('div');
      temporaryCard.innerHTML = renderVerificationCard(trip);

      card = temporaryCard.firstElementChild;

      if (!card) {
        showGlobal('Impossible de créer le formulaire de vérification.', true);
        return;
      }

      container.appendChild(card);
    }

    switchSection('trips');

    card.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    const result = card.querySelector('[name="boardingStatus"]');

    if (result) {
      result.value = 'boarded';
      result.focus({ preventScroll: true });
    }

    return;
  }

  // Modification du voyage
  const button = event.target.closest('[data-edit-trip]');

  if (!button || button.disabled) return;

  const trip = state.trips.find(
    item => Number(item.id) === Number(button.dataset.editTrip)
  );

  if (!trip) return;

  const form = $('#tripForm');

  form.elements.tripId.value = trip.id;
  form.elements.userId.value = trip.userId;
  form.elements.userId.disabled = true;
  form.elements.departureDate.value =
    String(trip.departureDate || '').slice(0, 10);
  form.elements.departureCity.value = trip.departureCity || '';
  form.elements.destination.value = trip.destination || '';
  form.elements.arrivalDate.value =
    String(trip.arrivalDate || '').slice(0, 10);
  form.elements.arrivalCity.value = trip.arrivalCity || '';
  form.elements.referenceCode.value = trip.referenceCode || '';
  form.elements.transport.value = trip.transport || '';
  form.elements.notes.value = trip.notes || '';
  form.elements.status.value = trip.status || 'planned';

  $('#tripFormTitle').textContent = `Modifier le voyage #${trip.id}`;
  $('#tripSubmit').textContent = 'Enregistrer les modifications';
  $('#cancelEdit').hidden = false;

  switchSection('trips');

  form.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
});

$('#tripForm').addEventListener('submit', async event => {
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
      setMessage(message, 'Voyage mis à jour.', true);
    } else {
      await api('/api/admin/trips', { method: 'POST', body: JSON.stringify(data) });
      setMessage(message, 'Voyage créé.', true);
    }
    resetTripForm();
    await loadData();
  } catch (error) { setMessage(message, error.message); }
  finally { $('#tripSubmit').disabled = false; }
});

// Vérification individuelle : uniquement après consultation du rapport de vol.
$('#pendingVerificationList').addEventListener('submit', async event => {
  const form = event.target.closest('[data-verify-trip]');
  if (!form) return;
  event.preventDefault();
  const tripId = form.dataset.verifyTrip;
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('.message');
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['airline','flightNumber','flightReportReference','actualDepartureDate','actualArrivalDate','observation']) {
    if (!data[key]) delete data[key];
  }
  if (data.actualDepartureDate && data.actualArrivalDate && data.actualArrivalDate < data.actualDepartureDate) {
    setMessage(message, "La date d'arrivée ne peut pas précéder la date de départ.");
    return;
  }
  if (!window.confirm(`Confirmer le résultat « ${data.boardingStatus === 'boarded' ? 'Embarqué' : 'Non embarqué'} » pour ce voyageur ?`)) return;
  button.disabled = true;
  setMessage(message, 'Enregistrement de la vérification…');
  try {
    await api(`/api/admin/trips/${encodeURIComponent(tripId)}/verify`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    await loadData();
    showGlobal('Vérification enregistrée. Le résultat est maintenant visible dans le dossier du voyageur.');
  } catch (error) {
    setMessage(message, error.message);
    button.disabled = false;
  }
});

$('#notificationForm').addEventListener('submit', async event => {
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
