'use strict';

/* ================================================================
 *  AuthService —— Supabase Auth browser client wrapper
 * ================================================================ */
const AuthService = {
  _client: null,
  _session: null,
  _user: null,
  _configured: false,
  _listeners: [],

  async init(onChange) {
    if (typeof onChange === 'function') this._listeners.push(onChange);

    const config = window.APP_CONFIG || {};
    this._configured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
    if (!this._configured) {
      this._notify();
      return;
    }

    this._client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data } = await this._client.auth.getSession();
    this._setSession(data?.session || null);

    this._client.auth.onAuthStateChange((_event, session) => {
      this._setSession(session || null);
    });
  },

  isConfigured() {
    return this._configured;
  },

  getUser() {
    return this._user;
  },

  async getAccessToken() {
    if (!this._client) return '';
    const { data } = await this._client.auth.getSession();
    this._setSession(data?.session || null, false);
    return this._session?.access_token || '';
  },

  async signIn(email, password) {
    if (!this._client) throw new Error('Supabase Auth 未配置');
    const { data, error } = await this._client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this._setSession(data?.session || null);
    return data;
  },

  async signUp(email, password) {
    if (!this._client) throw new Error('Supabase Auth 未配置');
    const { data, error } = await this._client.auth.signUp({ email, password });
    if (error) throw error;
    this._setSession(data?.session || null);
    return data;
  },

  async signOut() {
    if (!this._client) return;
    const { error } = await this._client.auth.signOut();
    if (error) throw error;
    this._setSession(null);
  },

  _setSession(session, notify = true) {
    this._session = session || null;
    this._user = this._session?.user || null;
    if (notify) this._notify();
  },

  _notify() {
    for (const listener of this._listeners) {
      listener(this._session, this._user);
    }
  }
};
