import React, { useEffect, useMemo, useState } from 'react';
import { Button, FlatList, SafeAreaView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';

const defaultBackend = '';

function useBackend() {
  const [baseUrl, setBaseUrl] = useState(defaultBackend);
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('tt_backend_url');
        if (saved) setBaseUrl(saved);
      } catch {}
    })();
  }, []);
  const save = async (url) => {
    setBaseUrl(url);
    try { await AsyncStorage.setItem('tt_backend_url', url); } catch {}
  };
  return { baseUrl, setBaseUrl: save };
}

function Field({ label, value, onChangeText, secureTextEntry, placeholder }){
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontWeight: '600', marginBottom: 4 }}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder}
        secureTextEntry={secureTextEntry}
        autoCapitalize='none' autoCorrect={false}
        style={{ borderWidth: 1, borderColor: '#ddd', padding: 10, borderRadius: 6 }} />
    </View>
  );
}

export default function App() {
  const { baseUrl, setBaseUrl } = useBackend();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [taskForm, setTaskForm] = useState({ title: '', everyDays: '1', nextDue: '2025-01-01', remindAt: '09:00', notes: '', priority: false });
  const [message, setMessage] = useState('');

  const headers = useMemo(() => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);

  const call = async (path, opts = {}) => {
    if (!baseUrl) throw new Error('Set backend URL');
    const res = await fetch(baseUrl + path, { ...opts, headers: { ...(opts.headers || {}), ...headers } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  };

  const doRegister = async () => {
    try {
      const data = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
      setUser(data.user); setToken(data.token); setMessage('Registered');
    } catch (e) { setMessage(e.message); }
  };
  const doLogin = async () => {
    try {
      const data = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setUser(data.user); setToken(data.token); setMessage('Logged in');
    } catch (e) { setMessage(e.message); }
  };
  const loadTasks = async () => {
    try {
      const data = await call('/api/tasks', { method: 'GET' });
      setTasks(data.tasks || []);
    } catch (e) { setMessage(e.message); }
  };
  const createTask = async () => {
    try {
      const payload = { ...taskForm, everyDays: parseInt(taskForm.everyDays || '1', 10), priority: !!taskForm.priority };
      await call('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      setMessage('Task created');
      await loadTasks();
    } catch (e) { setMessage(e.message); }
  };
  const deleteTask = async (id) => {
    try { await call(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadTasks(); } catch (e) { setMessage(e.message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <StatusBar style="auto" />
      <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 8 }}>TickTock Tasks (Mobile)</Text>

      <Field label="Backend URL" value={baseUrl} onChangeText={setBaseUrl} placeholder="https://abc123.execute-api.us-east-1.amazonaws.com" />

      {!user && (
        <View style={{ marginVertical: 10, padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Sign in</Text>
          <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button title="Register" onPress={doRegister} />
            <View style={{ width: 12 }} />
            <Button title="Login" onPress={doLogin} />
          </View>
        </View>
      )}

      {user && (
        <View style={{ marginVertical: 10, padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Hello, {user.email}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Button title="Load Tasks" onPress={loadTasks} />
            <View style={{ width: 12 }} />
            <Button title="Logout" color="#d11" onPress={() => { setUser(null); setToken(''); setTasks([]); }} />
          </View>
          <View>
            <Text style={{ fontWeight: '600', marginBottom: 4 }}>New Task</Text>
            <Field label="Title" value={taskForm.title} onChangeText={v => setTaskForm({ ...taskForm, title: v })} />
            <Field label="Notes" value={taskForm.notes} onChangeText={v => setTaskForm({ ...taskForm, notes: v })} />
            <Field label="Every N days" value={String(taskForm.everyDays)} onChangeText={v => setTaskForm({ ...taskForm, everyDays: v })} />
            <Field label="Next Due (YYYY-MM-DD)" value={taskForm.nextDue} onChangeText={v => setTaskForm({ ...taskForm, nextDue: v })} />
            <Field label="Remind At (HH:MM)" value={taskForm.remindAt} onChangeText={v => setTaskForm({ ...taskForm, remindAt: v })} />
            <Button title="Create Task" onPress={createTask} />
          </View>
        </View>
      )}

      <Text style={{ color: message.includes('HTTP') || message.includes('error') ? '#b00' : '#0a0', marginBottom: 8 }}>{message}</Text>

      <FlatList
        data={tasks}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={{ padding: 12, borderBottomWidth: 1, borderColor: '#eee', flexDirection: 'row', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={{ fontWeight: '600' }}>{item.title}</Text>
              <Text>{item.notes}</Text>
              <Text>Every {item.everyDays} day(s) • Next {item.nextDue} at {item.remindAt}</Text>
            </View>
            <TouchableOpacity onPress={() => deleteTask(item.id)} style={{ padding: 8 }}>
              <Text style={{ color: '#d11' }}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={<Text style={{ textAlign: 'center', color: '#666' }}>{user ? 'No tasks yet' : 'Login to see tasks'}</Text>}
      />
    </SafeAreaView>
  );
}
