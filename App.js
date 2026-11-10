/**
 * PlanningVoyage - Application Android
 * Toutes les vues et fonctionnalités sont regroupées dans ce fichier.
 * Configure API_BASE_URL avant de compiler l'application.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput,
  TouchableOpacity, View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import ReactNativeBlobUtil from 'react-native-blob-util';

const API_BASE_URL = 'http://10.0.2.2:5000/api';
// Android emulator: 10.0.2.2. Physical phone: replace with the server LAN IP or HTTPS domain.

const COLORS = {
  navy: '#142B4A', blue: '#246BCE', pale: '#F2F6FC',
  white: '#FFFFFF', text: '#1D2939', muted: '#667085',
  green: '#16865B', orange: '#D97706', red: '#C0392B', border: '#E3EAF3'
};

const dateLabel = value => {
  if (!value) return 'Non renseignée';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('fr-FR');
};

export default function App() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [screen, setScreen] = useState('home');
  const [trips, setTrips] = useState([]);
  const [nextTrip, setNextTrip] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const api = async (path, options = {}) => {
    const response = await fetch(API_BASE_URL + path, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      let message = 'Erreur serveur (' + response.status + ')';
      if (contentType.includes('application/json')) {
        const body = await response.json();
        message = body.message || message;
      }
      throw new Error(message);
    }
    if (contentType.includes('application/pdf')) return response;
    return response.json();
  };

  const logout = async () => {
    await AsyncStorage.multiRemove(['pv_token', 'pv_user']);
    setToken('');
    setUser(null);
    setTrips([]);
    setNextTrip(null);
    setNotifications([]);
    setScreen('home');
    setPassword('');
  };

  const loadAccountData = async authToken => {
    const headers = { Authorization: 'Bearer ' + authToken, Accept: 'application/json' };
    const [tripResponse, notificationResponse] = await Promise.all([
      fetch(API_BASE_URL + '/me/trips', { headers }),
      fetch(API_BASE_URL + '/me/notifications', { headers })
    ]);
    if (!tripResponse.ok || !notificationResponse.ok) throw new Error('Impossible de charger les informations du compte.');
    const tripData = await tripResponse.json();
    setNextTrip(tripData.nextTrip || null);
    setTrips(tripData.trips || []);
    setNotifications(await notificationResponse.json());
  };

  const registerPush = async authToken => {
    try {
      const permission = await messaging().requestPermission();
      const enabled =
        permission === messaging.AuthorizationStatus.AUTHORIZED ||
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
    let unsubscribeForeground;
    let unsubscribeOpened;
    const restore = async () => {
      try {
        const savedToken = await AsyncStorage.getItem('pv_token');
        const savedUser = await AsyncStorage.getItem('pv_user');
        if (savedToken && savedUser) {
          const response = await fetch(API_BASE_URL + '/me', {
            headers: { Authorization: 'Bearer ' + savedToken }
          });
          if (response.ok) {
            const profile = await response.json();
            setToken(savedToken);
            setUser(profile);
            await loadAccountData(savedToken);
            registerPush(savedToken);
          } else {
            await AsyncStorage.multiRemove(['pv_token', 'pv_user']);
          }
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    restore();
    unsubscribeForeground = messaging().onMessage(async remoteMessage => {
      const title = remoteMessage.notification?.title || 'PlanningVoyage';
      const body = remoteMessage.notification?.body || 'Vous avez reçu une notification.';
      Alert.alert(title, body);
      if (token) {
        try {
          const list = await fetch(API_BASE_URL + '/me/notifications', {
            headers: { Authorization: 'Bearer ' + token }
          });
          if (list.ok) setNotifications(await list.json());
        } catch (_) {}
      }
    });
    unsubscribeOpened = messaging().onNotificationOpenedApp(() => setScreen('notifications'));
    messaging().getInitialNotification().then(message => {
      if (message) setScreen('notifications');
    });
    return () => {
      unsubscribeForeground?.();
      unsubscribeOpened?.();
    };
  }, []);

  const login = async () => {
    if (!email.trim() || !password) {
      setError('Saisissez votre email et votre mot de passe.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(API_BASE_URL + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Connexion impossible.');
      await AsyncStorage.setItem('pv_token', data.token);
      await AsyncStorage.setItem('pv_user', JSON.stringify(data.user));
      setToken(data.token);
      const profileResponse = await fetch(API_BASE_URL + '/me', {
        headers: { Authorization: 'Bearer ' + data.token }
      });
      const profile = profileResponse.ok ? await profileResponse.json() : data.user;
      setUser(profile);
      await loadAccountData(data.token);
      registerPush(data.token);
      setPassword('');
      setScreen(data.user.mustChangePassword ? 'changePassword' : 'home');
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
    setBusy(true);
    try {
      await api('/me/change-password', {
        method: 'POST', body: JSON.stringify({ newPassword })
      });
      setNewPassword('');
      Alert.alert('Sécurité', 'Mot de passe modifié. Veuillez vous reconnecter.');
      await logout();
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
    setBusy(true);
    try {
      const path = ReactNativeBlobUtil.fs.dirs.DownloadDir + '/PlanningVoyage-Historique.pdf';
      const result = await ReactNativeBlobUtil.config({
        path,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          title: 'Historique PlanningVoyage',
          description: 'Téléchargement du PDF',
          mime: 'application/pdf',
          mediaScannable: true
        }
      }).fetch('GET', API_BASE_URL + '/me/history.pdf', {
        Authorization: 'Bearer ' + token
      });
      Alert.alert('PDF téléchargé', 'Votre historique est enregistré dans Téléchargements.');
      try {
        ReactNativeBlobUtil.android.actionViewIntent(result.path(), 'application/pdf');
      } catch (_) {}
    } catch (e) {
      Alert.alert('Téléchargement impossible', e.message);
    } finally {
      setBusy(false);
    }
  };

  const markRead = async id => {
    try {
      await api('/me/notifications/' + id + '/read', { method: 'PATCH' });
      setNotifications(current => current.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
    } catch (e) {
      Alert.alert('Erreur', e.message);
    }
  };

  const unreadCount = useMemo(() => notifications.filter(n => !n.readAt).length, [notifications]);

  const Button = ({ title, onPress, secondary = false, disabled = false }) => (
    <TouchableOpacity
      activeOpacity={0.8}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </TouchableOpacity>
  );

  const TripCard = ({ item, upcoming = false }) => (
    <View style={styles.tripCard}>
      <View style={styles.tripHeader}>
        <Text style={styles.tripTitle}>{item.destination}</Text>
        <Text style={[styles.status, item.status === 'confirmed' ? styles.confirmed : styles.planned]}>
          {item.status === 'confirmed' ? 'Confirmé' : item.status === 'completed' ? 'Terminé' : 'Programmé'}
        </Text>
      </View>
      <Text style={styles.tripLine}>Départ : {dateLabel(item.departureDate)}</Text>
      <Text style={styles.tripLine}>Ville de départ : {item.departureCity || '—'}</Text>
      <Text style={styles.tripLine}>Destination : {item.destination}</Text>
      <Text style={styles.tripLine}>Arrivée : {dateLabel(item.arrivalDate)}{item.arrivalCity ? ' - ' + item.arrivalCity : ''}</Text>
      {item.referenceCode ? <Text style={styles.tripLine}>Référence : {item.referenceCode}</Text> : null}
      {item.transport ? <Text style={styles.tripLine}>Transport : {item.transport}</Text> : null}
      {item.notes ? <Text style={styles.tripNotes}>{item.notes}</Text> : null}
    </View>
  );

  if (loading) {
    return <SafeAreaView style={styles.center}><ActivityIndicator size="large" color={COLORS.blue} /><Text style={styles.muted}>Chargement de PlanningVoyage…</Text></SafeAreaView>;
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
            <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="nom@exemple.com" placeholderTextColor="#98A2B3" style={styles.input} />
            <Text style={styles.label}>Mot de passe</Text>
            <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="Votre mot de passe" placeholderTextColor="#98A2B3" style={styles.input} />
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
        <View style={styles.page}>
          <Text style={styles.heading}>Sécurisez votre compte</Text>
          <Text style={styles.muted}>L'administrateur vous a fourni un mot de passe initial. Choisissez un nouveau mot de passe d'au moins 12 caractères.</Text>
          <TextInput value={newPassword} onChangeText={setNewPassword} secureTextEntry placeholder="Nouveau mot de passe" style={styles.input} />
          <Button title="Modifier le mot de passe" onPress={changePassword} disabled={busy} />
        </View>
      ) : (
        <>
          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            {screen === 'home' && (
              <>
                <Text style={styles.pageTitle}>Bonjour, {user.fullName || user.full_name || 'Voyageur'}</Text>
                <Text style={styles.muted}>Voici les informations de votre dossier de voyage.</Text>
                <View style={styles.summaryRow}>
                  <View style={styles.summaryBox}><Text style={styles.summaryNumber}>{trips.length}</Text><Text style={styles.summaryLabel}>Voyages</Text></View>
                  <View style={styles.summaryBox}><Text style={styles.summaryNumber}>{unreadCount}</Text><Text style={styles.summaryLabel}>Non lus</Text></View>
                </View>
                <Text style={styles.sectionTitle}>Prochain voyage</Text>
                {nextTrip ? <TripCard item={nextTrip} upcoming /> : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucun voyage programmé</Text><Text style={styles.muted}>Le bureau affichera ici votre prochain déplacement dès son enregistrement.</Text></View>}
                <Button title="Actualiser mes informations" onPress={refresh} secondary disabled={busy} />
              </>
            )}

            {screen === 'trips' && (
              <>
                <Text style={styles.pageTitle}>Mon planning</Text>
                <Text style={styles.muted}>Votre prochain voyage et les déplacements déjà effectués.</Text>
                {trips.length ? [...trips].sort((a,b) => String(b.departureDate).localeCompare(String(a.departureDate))).map(item => <TripCard key={String(item.id)} item={item} />) : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucun voyage</Text><Text style={styles.muted}>Aucun déplacement n'est encore enregistré dans votre compte.</Text></View>}
              </>
            )}

            {screen === 'history' && (
              <>
                <Text style={styles.pageTitle}>Mon historique</Text>
                <Text style={styles.muted}>Téléchargez votre historique personnel au format PDF.</Text>
                {trips.filter(t => t.status === 'completed' || String(t.departureDate) < new Date().toISOString().slice(0,10)).length
                  ? trips.filter(t => t.status === 'completed' || String(t.departureDate) < new Date().toISOString().slice(0,10)).map(item => <TripCard key={String(item.id)} item={item} />)
                  : <View style={styles.empty}><Text style={styles.emptyTitle}>Historique vide</Text><Text style={styles.muted}>Vos voyages passés apparaîtront ici.</Text></View>}
                <Button title="Télécharger mon historique PDF" onPress={openHistoryPdf} disabled={busy} />
              </>
            )}

            {screen === 'notifications' && (
              <>
                <Text style={styles.pageTitle}>Mes notifications</Text>
                <Text style={styles.muted}>Messages personnels envoyés par le bureau.</Text>
                {notifications.length ? notifications.map(item => (
                  <TouchableOpacity key={String(item.id)} style={[styles.noticeCard, !item.readAt && styles.noticeUnread]} onPress={() => !item.readAt && markRead(item.id)}>
                    <View style={styles.noticeHeader}><Text style={styles.noticeTitle}>{item.title}</Text><Text style={styles.noticeDate}>{dateLabel(item.sentAt)}</Text></View>
                    <Text style={styles.tripLine}>{item.body}</Text>
                    <Text style={styles.noticeState}>{item.readAt ? 'Lu' : 'Appuyez pour marquer comme lu'}</Text>
                  </TouchableOpacity>
                )) : <View style={styles.empty}><Text style={styles.emptyTitle}>Aucune notification</Text><Text style={styles.muted}>Les messages du bureau apparaîtront ici.</Text></View>}
              </>
            )}
          </ScrollView>
          <View style={styles.tabBar}>
            {[
              ['home','Accueil','⌂'], ['trips','Planning','▤'],
              ['history','Historique','◷'], ['notifications','Messages' + (unreadCount ? ' (' + unreadCount + ')' : ''),'♢']
            ].map(([key,label,icon]) => (
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
  page: { flex: 1, padding: 20, gap: 14 },
  pageTitle: { color: COLORS.navy, fontSize: 23, fontWeight: '800', marginBottom: 5 },
  heading: { color: COLORS.navy, fontSize: 21, fontWeight: '800', marginBottom: 14 },
  muted: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  label: { color: COLORS.text, fontWeight: '700', marginBottom: 7, marginTop: 10 },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 13, paddingVertical: 12, color: COLORS.text, marginBottom: 10 },
  button: { backgroundColor: COLORS.blue, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 11, alignItems: 'center', marginTop: 12 },
  buttonText: { color: COLORS.white, fontWeight: '800', fontSize: 14 },
  buttonSecondary: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.blue },
  buttonSecondaryText: { color: COLORS.blue },
  disabled: { opacity: 0.55 },
  error: { color: COLORS.red, marginTop: 8, fontSize: 13 },
  summaryRow: { flexDirection: 'row', gap: 12, marginVertical: 20 },
  summaryBox: { flex: 1, backgroundColor: COLORS.white, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border },
  summaryNumber: { fontSize: 26, fontWeight: '900', color: COLORS.blue },
  summaryLabel: { color: COLORS.muted, marginTop: 4 },
  sectionTitle: { color: COLORS.navy, fontWeight: '800', fontSize: 17, marginBottom: 10 },
  tripCard: { backgroundColor: COLORS.white, borderRadius: 14, padding: 15, borderWidth: 1, borderColor: COLORS.border, marginTop: 12 },
  tripHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 9 },
  tripTitle: { color: COLORS.navy, fontWeight: '800', fontSize: 17, flex: 1 },
  status: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 20, overflow: 'hidden' },
  confirmed: { backgroundColor: '#DDF6EA', color: COLORS.green },
  planned: { backgroundColor: '#FFF1D6', color: COLORS.orange },
  tripLine: { color: COLORS.text, fontSize: 13, lineHeight: 21 },
  tripNotes: { color: COLORS.muted, marginTop: 8, fontStyle: 'italic' },
  empty: { backgroundColor: COLORS.white, padding: 20, borderRadius: 14, marginTop: 14, borderWidth: 1, borderColor: COLORS.border },
  emptyTitle: { color: COLORS.navy, fontWeight: '800', marginBottom: 7 },
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
