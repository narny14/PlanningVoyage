/**
 * PlanningVoyage - Application Android
 * Historique fondé exclusivement sur la confirmation individuelle de l'administration.
 * Un voyage passé n'est jamais considéré comme effectué sur la seule base de sa date.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, SafeAreaView,
  ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import ReactNativeBlobUtil from 'react-native-blob-util';

const API_BASE_URL = 'https://planningvoyagenode.byteatomeneons.com/api';
const COLORS = {
  navy: '#142B4A', blue: '#246BCE', pale: '#F2F6FC', white: '#FFFFFF',
  text: '#1D2939', muted: '#667085', green: '#16865B', orange: '#D97706',
  red: '#C0392B', border: '#E3EAF3', lightGreen: '#DDF6EA', lightOrange: '#FFF1D6',
  lightRed: '#FDE8E7'
};
const dateLabel = value => {
  if (!value) return 'Non renseignée';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('fr-FR');
};
const mustChangePassword = account => {
  const value = account?.mustChangePassword ?? account?.must_change_password;
  return value === true || value === 1 || value === '1';
};
const normalizeList = value => Array.isArray(value) ? value : [];

export default function App() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [screen, setScreen] = useState('home');

  const [upcomingTrips, setUpcomingTrips] = useState([]);
  const [historyTrips, setHistoryTrips] = useState([]);
  const [pendingVerificationTrips, setPendingVerificationTrips] = useState([]);
  const [notBoardedTrips, setNotBoardedTrips] = useState([]);
  const [nextTrip, setNextTrip] = useState(null);
  const [notifications, setNotifications] = useState([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const api = useCallback(async (path, options = {}, authToken = token) => {
  const response = await fetch(API_BASE_URL + path, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!response.ok) {
    throw new Error(data?.message || `Erreur serveur (${response.status}).`);
  }

  if (
    raw &&
    !data &&
    !(response.headers.get('content-type') || '').includes('application/pdf')
  ) {
    throw new Error('Le serveur a renvoyé une réponse invalide.');
  }

  return data;
}, [token]);

  const clearAccount = async () => {
    await AsyncStorage.multiRemove(['pv_token', 'pv_user']);
    setToken('');
    setUser(null);
    setUpcomingTrips([]);
    setHistoryTrips([]);
    setPendingVerificationTrips([]);
    setNotBoardedTrips([]);
    setNextTrip(null);
    setNotifications([]);
    setEmail('');
    setPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setError('');
    setScreen('home');
  };
  const logout = async () => clearAccount();

  const loadAccountData = useCallback(async authToken => {
  const [tripData, notificationData] = await Promise.all([
    api('/me/trips', {}, authToken),
    api('/me/notifications', {}, authToken)
  ]);

  const upcoming = normalizeList(tripData.upcomingTrips);

  const history = normalizeList(tripData.historyTrips)
    .filter(t => t.boardingStatus === 'boarded');

  const pending = normalizeList(tripData.pendingVerificationTrips);
  const notBoarded = normalizeList(tripData.notBoardedTrips);

  setUpcomingTrips(upcoming);
  setHistoryTrips(history);
  setPendingVerificationTrips(pending);
  setNotBoardedTrips(notBoarded);

  setNextTrip(tripData.nextTrip || upcoming[0] || null);
  setNotifications(normalizeList(notificationData));
}, [api]);

  const registerPush = async authToken => {
    try {
      const permission = await messaging().requestPermission();
      const enabled = permission === messaging.AuthorizationStatus.AUTHORIZED ||
        permission === messaging.AuthorizationStatus.PROVISIONAL;
      if (!enabled) return;
      const fcmToken = await messaging().getToken();
      await fetch(API_BASE_URL + '/me/device-token', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fcmToken, platform: 'android' })
      });
    } catch (e) {
      console.warn('Firebase Messaging:', e.message);
    }
  };

  useEffect(() => {
    let active = true;
    let unsubscribeForeground;
    let unsubscribeOpened;
    const restore = async () => {
      try {
        const savedToken = await AsyncStorage.getItem('pv_token');
        const savedUser = await AsyncStorage.getItem('pv_user');
        if (savedToken && savedUser) {
          const profile = await api('/me', {}, savedToken);
          if (!active) return;
          setToken(savedToken);
          setUser(profile);
          if (mustChangePassword(profile)) {
            setScreen('changePassword');
          } else {
            setScreen('home');
            await loadAccountData(savedToken);
            if (active) registerPush(savedToken);
          }
        } else if (savedToken || savedUser) {
          await AsyncStorage.multiRemove(['pv_token', 'pv_user']);
        }
      } catch (e) {
        if (active) setError(e.message);
        await AsyncStorage.multiRemove(['pv_token', 'pv_user']);
      } finally {
        if (active) setLoading(false);
      }
    };
    restore();

    unsubscribeForeground = messaging().onMessage(async remoteMessage => {
      const title = remoteMessage.notification?.title || 'PlanningVoyage';
      const body = remoteMessage.notification?.body || 'Vous avez reçu une notification.';
      Alert.alert(title, body);
      try {
        const savedToken = await AsyncStorage.getItem('pv_token');
        if (savedToken) {
          const data = await api('/me/notifications', {}, savedToken);
          if (active) setNotifications(normalizeList(data));
        }
      } catch {}
    });
    unsubscribeOpened = messaging().onNotificationOpenedApp(() => setScreen('notifications'));
    messaging().getInitialNotification().then(message => {
      if (message && active) setScreen('notifications');
    });
    return () => {
      active = false;
      unsubscribeForeground?.();
      unsubscribeOpened?.();
    };
  }, [api, loadAccountData]);

  const login = async () => {
    if (!email.trim() || !password) {
      setError('Saisissez votre email et votre mot de passe.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password })
      }, '');
      if (!data?.token) throw new Error('Le serveur n’a pas retourné de jeton de connexion.');
      const profile = await api('/me', {}, data.token);
      await AsyncStorage.setItem('pv_token', data.token);
      await AsyncStorage.setItem('pv_user', JSON.stringify(profile));
      setToken(data.token);
      setUser(profile);
      setPassword('');
      if (mustChangePassword(profile) || mustChangePassword(data.user)) {
        setScreen('changePassword');
        return;
      }
      await loadAccountData(data.token);
      registerPush(data.token);
      setScreen('home');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 12) {
      Alert.alert('Mot de passe', 'Utilisez au moins 12 caractères.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      Alert.alert('Vérification', 'Les deux mots de passe ne correspondent pas.');
      return;
    }
    if (newPassword === password) {
      Alert.alert('Sécurité', 'Choisissez un mot de passe différent du mot de passe initial.');
      return;
    }
    setBusy(true);
    try {
      await api('/me/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
      setNewPassword('');
      setConfirmNewPassword('');
      Alert.alert(
        'Compte sécurisé',
        'Votre nouveau mot de passe a été enregistré. Connectez-vous maintenant avec celui-ci.',
        [{ text: 'Continuer', onPress: logout }]
      );
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await loadAccountData(token);
    } catch (e) {
      Alert.alert('Actualisation', e.message);
    } finally {
      setBusy(false);
    }
  };

  const openHistoryPdf = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const path = ReactNativeBlobUtil.fs.dirs.DownloadDir + '/PlanningVoyage-Historique.pdf';
      const result = await ReactNativeBlobUtil.config({
        path,
        addAndroidDownloads: {
          useDownloadManager: true, notification: true,
          title: 'Historique PlanningVoyage',
          description: 'Téléchargement du PDF',
          mime: 'application/pdf', mediaScannable: true
        }
      }).fetch('GET', API_BASE_URL + '/me/history.pdf', { Authorization: 'Bearer ' + token });
      Alert.alert('PDF téléchargé', 'Votre historique est enregistré dans Téléchargements.');
      try { ReactNativeBlobUtil.android.actionViewIntent(result.path(), 'application/pdf'); } catch {}
    } catch (e) {
      Alert.alert('Téléchargement impossible', e.message);
    } finally {
      setBusy(false);
    }
  };

  const markRead = async id => {
    try {
      await api('/me/notifications/' + id + '/read', { method: 'PATCH' });
      setNotifications(current => current.map(n =>
        String(n.id) === String(id) ? { ...n, readAt: new Date().toISOString() } : n
      ));
    } catch (e) {
      Alert.alert('Erreur', e.message);
    }
  };

  const unreadCount = useMemo(() => notifications.filter(n => !n.readAt).length, [notifications]);

  const Button = ({ title, onPress, secondary = false, disabled = false }) => (
    <TouchableOpacity activeOpacity={0.8} disabled={disabled} onPress={onPress}
      style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}>
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </TouchableOpacity>
  );

  const BoardingBadge = ({ status }) => {
    const config = {
      boarded: { label: 'Embarquement confirmé', box: styles.boardedBadge },
      not_boarded: { label: 'Non embarqué', box: styles.notBoardedBadge },
      pending: { label: 'En attente de confirmation', box: styles.pendingBadge }
    }[status] || { label: 'Statut non communiqué', box: styles.pendingBadge };
    return <Text style={[styles.badge, config.box]}>{config.label}</Text>;
  };

  const TripCard = ({ item, showBoarding = true }) => {
    const status = item.status || 'planned';
    const tripStatus = status === 'confirmed' ? 'Confirmé' : status === 'cancelled' ? 'Annulé' : 'Planifié';
    return (
      <View style={styles.tripCard}>
        <View style={styles.tripHeader}>
          <Text style={styles.tripTitle}>{item.destination || 'Destination non renseignée'}</Text>
          <Text style={[styles.status, status === 'confirmed' ? styles.confirmed : status === 'cancelled' ? styles.cancelled : styles.planned]}>
            {tripStatus}
          </Text>
        </View>
        {showBoarding ? <BoardingBadge status={item.boardingStatus || 'pending'} /> : null}
        <Text style={styles.tripLine}>Départ : {dateLabel(item.departureDate)}</Text>
        <Text style={styles.tripLine}>Ville de départ : {item.departureCity || '—'}</Text>
        <Text style={styles.tripLine}>Destination : {item.destination || '—'}</Text>
        <Text style={styles.tripLine}>Arrivée : {dateLabel(item.arrivalDate)}{item.arrivalCity ? ' - ' + item.arrivalCity : ''}</Text>
        {item.referenceCode ? <Text style={styles.tripLine}>Référence : {item.referenceCode}</Text> : null}
        {item.transport ? <Text style={styles.tripLine}>Transport : {item.transport}</Text> : null}
        {item.airline ? <Text style={styles.tripLine}>Compagnie : {item.airline}</Text> : null}
        {item.flightNumber ? <Text style={styles.tripLine}>Vol : {item.flightNumber}</Text> : null}
        {item.flightReportReference ? <Text style={styles.tripLine}>Rapport : {item.flightReportReference}</Text> : null}
        {item.actualDepartureDate ? <Text style={styles.tripLine}>Départ réel : {dateLabel(item.actualDepartureDate)}</Text> : null}
        {item.actualArrivalDate ? <Text style={styles.tripLine}>Arrivée réelle : {dateLabel(item.actualArrivalDate)}</Text> : null}
        {item.observation ? <Text style={styles.tripNotes}>{item.observation}</Text> : item.notes ? <Text style={styles.tripNotes}>{item.notes}</Text> : null}
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.blue} />
        <Text style={styles.muted}>Chargement de PlanningVoyage…</Text>
      </SafeAreaView>
    );
  }

  if (!token || !user) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.navy} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginWrap}>
          <View style={styles.brandCircle}><Text style={styles.brandInitial}>PV</Text></View>
          <Text style={styles.brand}>PlanningVoyage</Text>
          <Text style={styles.subtitle}>Votre espace personnel de voyage</Text>
          <View style={styles.loginCard}>
            <Text style={styles.heading}>Connexion</Text>
            <Text style={styles.label}>Adresse email</Text>
            <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
              keyboardType="email-address" placeholder="nom@exemple.com" placeholderTextColor="#98A2B3" style={styles.input} />
            <Text style={styles.label}>Mot de passe</Text>
            <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
              placeholder="Votre mot de passe" placeholderTextColor="#98A2B3" style={styles.input} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button title={busy ? 'Connexion…' : 'Se connecter'} onPress={login} disabled={busy} />
          </View>
          <Text style={styles.loginFooter}>Votre compte est créé par l'administration du bureau.</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.navy} />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topTitle}>PlanningVoyage</Text>
          <Text style={styles.topSub}>{user.fullName || user.full_name || user.email}</Text>
        </View>
        <TouchableOpacity onPress={() => Alert.alert('Déconnexion', 'Voulez-vous quitter votre compte ?', [
          { text: 'Annuler', style: 'cancel' }, { text: 'Déconnexion', style: 'destructive', onPress: logout }
        ])}>
          <Text style={styles.logout}>Quitter</Text>
        </TouchableOpacity>
      </View>

      {screen === 'changePassword' ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.passwordPage} keyboardShouldPersistTaps="handled">
            <View style={styles.brandCircle}><Text style={styles.brandInitial}>PV</Text></View>
            <Text style={styles.heading}>Bienvenue sur PlanningVoyage</Text>
            <Text style={styles.muted}>Votre compte a été créé par l'administration. Avant de commencer, choisissez votre mot de passe personnel. Cette étape protège l'accès à vos informations de voyage.</Text>
            <Text style={styles.label}>Nouveau mot de passe</Text>
            <TextInput value={newPassword} onChangeText={setNewPassword} secureTextEntry autoCapitalize="none"
              placeholder="12 caractères minimum" placeholderTextColor="#98A2B3" style={styles.input} />
            <Text style={styles.label}>Confirmer le mot de passe</Text>
            <TextInput value={confirmNewPassword} onChangeText={setConfirmNewPassword} secureTextEntry autoCapitalize="none"
              placeholder="Saisissez à nouveau le mot de passe" placeholderTextColor="#98A2B3" style={styles.input} />
            <Text style={styles.muted}>Utilisez au moins 12 caractères et choisissez un mot de passe différent de celui fourni par l'administration.</Text>
            <Button title={busy ? 'Enregistrement…' : 'Sécuriser mon compte'} onPress={changePassword} disabled={busy} />
            {busy ? <ActivityIndicator color={COLORS.blue} style={{ marginTop: 15 }} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <>
          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            {screen === 'home' && <>
              <Text style={styles.pageTitle}>Bonjour, {user.fullName || user.full_name || 'Voyageur'}</Text>
              <Text style={styles.muted}>Voici les informations de votre dossier de voyage.</Text>
              <View style={styles.summaryRow}>
                <View style={styles.summaryBox}><Text style={styles.summaryNumber}>{upcomingTrips.length}</Text><Text style={styles.summaryLabel}>À venir</Text></View>
                <View style={styles.summaryBox}><Text style={styles.summaryNumber}>{historyTrips.length}</Text><Text style={styles.summaryLabel}>Effectués</Text></View>
                <View style={styles.summaryBox}><Text style={styles.summaryNumber}>{unreadCount}</Text><Text style={styles.summaryLabel}>Non lus</Text></View>
              </View>
              <Text style={styles.sectionTitle}>Prochain voyage</Text>
              {nextTrip ? <TripCard item={nextTrip} /> : <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Aucun voyage programmé</Text>
                <Text style={styles.muted}>Le bureau affichera ici votre prochain déplacement dès son enregistrement.</Text>
              </View>}
              {pendingVerificationTrips.length > 0 ? <View style={styles.noticeInfo}>
                <Text style={styles.emptyTitle}>Vérification administrative en cours</Text>
                <Text style={styles.muted}>{pendingVerificationTrips.length} voyage(s) passé(s) attendent la confirmation du bureau. Ils ne sont pas encore ajoutés à votre historique.</Text>
              </View> : null}
              <Button title={busy ? 'Actualisation…' : 'Actualiser mes informations'} onPress={refresh} secondary disabled={busy} />
            </>}

            {screen === 'trips' && <>
              <Text style={styles.pageTitle}>Mon planning</Text>
              <Text style={styles.muted}>Les voyages à venir sont séparés des voyages passés en attente de vérification.</Text>
              <Text style={styles.sectionTitle}>Voyages à venir</Text>
              {upcomingTrips.length ? [...upcomingTrips].sort((a,b) => String(a.departureDate).localeCompare(String(b.departureDate))).map(item =>
                <TripCard key={String(item.id)} item={item} />
              ) : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucun départ à venir</Text><Text style={styles.muted}>Aucun voyage futur n'est actuellement programmé.</Text></View>}
              <Text style={styles.sectionTitle}>En attente de confirmation du bureau</Text>
              {pendingVerificationTrips.length ? pendingVerificationTrips.map(item =>
                <TripCard key={String(item.id)} item={{ ...item, boardingStatus: 'pending' }} />
              ) : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucune vérification en attente</Text><Text style={styles.muted}>Les voyages passés seront affichés ici jusqu'à la décision du bureau.</Text></View>}
              {notBoardedTrips.length ? <>
                <Text style={styles.sectionTitle}>Voyages non effectués</Text>
                {notBoardedTrips.map(item => <TripCard key={String(item.id)} item={{ ...item, boardingStatus: 'not_boarded' }} />)}
              </> : null}
            </>}

            {screen === 'history' && <>
              <Text style={styles.pageTitle}>Mon historique</Text>
              <Text style={styles.muted}>Seuls les voyages dont l'embarquement a été confirmé individuellement par le bureau apparaissent dans cet historique.</Text>
              {historyTrips.length ? historyTrips.slice().sort((a,b) => String(b.actualDepartureDate || b.departureDate).localeCompare(String(a.actualDepartureDate || a.departureDate))).map(item =>
                <TripCard key={String(item.id)} item={{ ...item, boardingStatus: 'boarded' }} />
              ) : <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Aucun vol confirmé</Text>
                <Text style={styles.muted}>Un voyage passé n'est pas automatiquement considéré comme effectué. Le bureau doit d'abord confirmer votre embarquement.</Text>
              </View>}
              <Button title={busy ? 'Téléchargement…' : 'Télécharger mon historique PDF'} onPress={openHistoryPdf} disabled={busy} />
            </>}

            {screen === 'notifications' && <>
              <Text style={styles.pageTitle}>Mes notifications</Text>
              <Text style={styles.muted}>Messages personnels envoyés par le bureau.</Text>
              {notifications.length ? notifications.map(item =>
                <TouchableOpacity key={String(item.id)} style={[styles.noticeCard, !item.readAt && styles.noticeUnread]}
                  onPress={() => !item.readAt && markRead(item.id)}>
                  <View style={styles.noticeHeader}><Text style={styles.noticeTitle}>{item.title}</Text><Text style={styles.noticeDate}>{dateLabel(item.sentAt)}</Text></View>
                  <Text style={styles.tripLine}>{item.body}</Text>
                  <Text style={styles.noticeState}>{item.readAt ? 'Lu' : 'Appuyez pour marquer comme lu'}</Text>
                </TouchableOpacity>
              ) : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucune notification</Text><Text style={styles.muted}>Les messages du bureau apparaîtront ici.</Text></View>}
            </>}
          </ScrollView>
          <View style={styles.tabBar}>
            {[
              ['home', 'Accueil', '⌂'], ['trips', 'Planning', '▤'],
              ['history', 'Historique', '◷'],
              ['notifications', 'Messages' + (unreadCount ? ' (' + unreadCount + ')' : ''), '♢']
            ].map(([key, label, icon]) => (
              <TouchableOpacity key={key} style={styles.tab} onPress={() => setScreen(key)}>
                <Text style={[styles.tabIcon, screen === key && styles.tabActive]}>{icon}</Text>
                <Text style={[styles.tabLabel, screen === key && styles.tabActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.pale },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.pale, gap: 12 },
  loginWrap: { flex: 1, backgroundColor: COLORS.navy, justifyContent: 'center', padding: 24 },
  brandCircle: { width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.white, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  brandInitial: { color: COLORS.blue, fontSize: 26, fontWeight: '900' },
  brand: { color: COLORS.white, fontSize: 28, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#D5E4F7', textAlign: 'center', marginTop: 6, marginBottom: 28 },
  loginCard: { backgroundColor: COLORS.white, borderRadius: 18, padding: 22 },
  loginFooter: { color: '#D5E4F7', textAlign: 'center', marginTop: 22, fontSize: 12 },
  topBar: { backgroundColor: COLORS.navy, paddingHorizontal: 20, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topTitle: { color: COLORS.white, fontSize: 19, fontWeight: '800' },
  topSub: { color: '#D5E4F7', marginTop: 3, fontSize: 12 },
  logout: { color: '#FFD6D6', fontWeight: '700' },
  content: { flex: 1 },
  contentInner: { padding: 18, paddingBottom: 30 },
  passwordPage: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  pageTitle: { color: COLORS.navy, fontSize: 23, fontWeight: '800', marginBottom: 5 },
  heading: { color: COLORS.navy, fontSize: 21, fontWeight: '800', marginBottom: 14, textAlign: 'center' },
  muted: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  label: { color: COLORS.text, fontWeight: '700', marginBottom: 7, marginTop: 10 },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 13, paddingVertical: 12, color: COLORS.text, marginBottom: 10 },
  button: { backgroundColor: COLORS.blue, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 11, alignItems: 'center', marginTop: 12 },
  buttonText: { color: COLORS.white, fontWeight: '800', fontSize: 14 },
  buttonSecondary: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.blue },
  buttonSecondaryText: { color: COLORS.blue },
  disabled: { opacity: 0.55 },
  error: { color: COLORS.red, marginTop: 8, fontSize: 13 },
  summaryRow: { flexDirection: 'row', gap: 9, marginVertical: 20 },
  summaryBox: { flex: 1, backgroundColor: COLORS.white, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border },
  summaryNumber: { fontSize: 24, fontWeight: '900', color: COLORS.blue },
  summaryLabel: { color: COLORS.muted, marginTop: 4, fontSize: 11 },
  sectionTitle: { color: COLORS.navy, fontWeight: '800', fontSize: 16, marginTop: 20, marginBottom: 8 },
  tripCard: { backgroundColor: COLORS.white, borderRadius: 14, padding: 15, borderWidth: 1, borderColor: COLORS.border, marginTop: 12 },
  tripHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 9 },
  tripTitle: { color: COLORS.navy, fontWeight: '800', fontSize: 17, flex: 1 },
  status: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 20, overflow: 'hidden' },
  confirmed: { backgroundColor: COLORS.lightGreen, color: COLORS.green },
  planned: { backgroundColor: COLORS.lightOrange, color: COLORS.orange },
  cancelled: { backgroundColor: COLORS.lightRed, color: COLORS.red },
  badge: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '800', paddingHorizontal: 9, paddingVertical: 6, borderRadius: 20, overflow: 'hidden', marginBottom: 9 },
  boardedBadge: { backgroundColor: COLORS.lightGreen, color: COLORS.green },
  pendingBadge: { backgroundColor: COLORS.lightOrange, color: COLORS.orange },
  notBoardedBadge: { backgroundColor: COLORS.lightRed, color: COLORS.red },
  tripLine: { color: COLORS.text, fontSize: 13, lineHeight: 21 },
  tripNotes: { color: COLORS.muted, marginTop: 8, fontStyle: 'italic' },
  empty: { backgroundColor: COLORS.white, padding: 20, borderRadius: 14, marginTop: 14, borderWidth: 1, borderColor: COLORS.border },
  emptyTitle: { color: COLORS.navy, fontWeight: '800', marginBottom: 7 },
  noticeInfo: { backgroundColor: '#EAF2FF', padding: 15, borderRadius: 13, marginTop: 14, borderWidth: 1, borderColor: '#C9DBF7' },
  noticeCard: { backgroundColor: COLORS.white, borderRadius: 13, padding: 15, borderWidth: 1, borderColor: COLORS.border, marginTop: 12 },
  noticeUnread: { borderLeftWidth: 4, borderLeftColor: COLORS.blue },
  noticeHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  noticeTitle: { color: COLORS.navy, fontWeight: '800', flex: 1 },
  noticeDate: { color: COLORS.muted, fontSize: 10 },
  noticeState: { color: COLORS.blue, fontSize: 11, marginTop: 8, fontWeight: '700' },
  tabBar: { flexDirection: 'row', backgroundColor: COLORS.white, borderTopWidth: 1, borderTopColor: COLORS.border, paddingVertical: 8, paddingBottom: Platform.OS === 'ios' ? 20 : 8 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: { color: COLORS.muted, fontSize: 19 },
  tabLabel: { color: COLORS.muted, fontSize: 10, fontWeight: '600' },
  tabActive: { color: COLORS.blue, fontWeight: '900' }
});
