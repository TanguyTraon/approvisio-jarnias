require('dotenv').config();
// rebuild 17/07 v2
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

// ── WEB PUSH (notifications type app, iOS 16.4+ / Android / desktop) ──
// Chargement défensif : si le module ou les clés manquent, le push est
// simplement désactivé, le reste de l'app continue de tourner normalement.
let webpush = null, PUSH_ENABLED = false;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@jarnias.fr';
try {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    PUSH_ENABLED = true;
    console.log('Web push activé.');
  } else {
    console.log('Web push désactivé (clés VAPID absentes).');
  }
} catch (e) {
  console.log('Web push indisponible (module web-push non installé) :', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'jarnias-approvisio-change-me';

// Code admin par défaut (1er compte). Fourni dans le guide.
const BOOTSTRAP_ADMIN_CODE = process.env.ADMIN_CODE || 'JARNIAS-ADMIN-2026';

// ── EMAIL (Resend) ────────────────────────────────────────────
// Clé API Resend (optionnelle : si absente, seules les notifs cloche fonctionnent)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Adresse expéditrice. Par défaut le domaine de test Resend (fonctionne sans config DNS).
const MAIL_FROM = process.env.MAIL_FROM || 'AppROVISIO <onboarding@resend.dev>';
// URL publique de l'app (pour les liens dans les mails)
const APP_URL = process.env.APP_URL || '';

// Le réglage « notifications par email » vit dans app_lists.config (tableau [CONFIG]),
// écrit par le front via POST /api/lists/config/set. On le relit ici, avec un petit cache
// pour ne pas requêter la base à chaque email. mailNotifs === false => aucun email n'est envoyé.
let _mailCfgCache = { at: 0, on: true };
async function mailNotifsEnabled() {
  const now = Date.now();
  if (now - _mailCfgCache.at < 30000) return _mailCfgCache.on;
  let on = true; // par défaut : activé (comportement historique)
  try {
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', ['config']);
    const cfg = rows[0] && Array.isArray(rows[0].data) ? rows[0].data[0] : null;
    if (cfg && cfg.mailNotifs === false) on = false;
  } catch (e) {
    console.error('Lecture config mailNotifs:', e.message);
  }
  _mailCfgCache = { at: now, on };
  return on;
}
// Invalide le cache dès que la config change (voir POST /api/lists/:name/set)
function invalidateMailCfgCache() { _mailCfgCache.at = 0; }

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return; // pas de clé ou pas d'email : on saute silencieusement
  if (!(await mailNotifsEnabled())) return; // emails désactivés dans le paramétrage
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Erreur envoi email:', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.error('Erreur envoi email:', e.message);
  }
}

function emailTemplate(title, message, ctaLabel) {
  const btn = APP_URL
    ? `<a href="${APP_URL}" style="display:inline-block;margin-top:18px;background:#0F172A;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">${ctaLabel || 'Ouvrir AppROVISIO'}</a>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1E293B">
    <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:4px">JARNIAS <span style="font-weight:400;color:#64748B">AppROVISIO</span></div>
    <div style="height:2px;background:#0F172A;margin:8px 0 18px"></div>
    <div style="font-size:16px;font-weight:600;margin-bottom:8px">${title}</div>
    <div style="font-size:14px;color:#475569;line-height:1.6">${message}</div>
    ${btn}
    <div style="margin-top:24px;font-size:12px;color:#94A3B8">Notification automatique \u2014 AppROVISIO JARNIAS</div>
  </div>`;
}

// Crée une notification en base + envoie l'email correspondant
async function logEvent(approId, type, actorName) {
  try {
    await pool.query('INSERT INTO appro_events (appro_id, type, actor_name) VALUES ($1,$2,$3)', [approId, type, actorName || null]);
  } catch (e) { /* historique non bloquant */ }
}

// Quand une appro passe "sur chantier", ses filets suivent automatiquement (Su :
// "un filet passe au dépôt → sur chantier automatiquement, lié au statut de l'appro").
// Centralisé ici plutôt que dupliqué dans chaque endroit qui peut faire passer une
// appro sur chantier (bouton rapide dépôt, fiche complète, bascule libre du statut).
async function cascadeFiletsToChantier(approId) {
  try {
    await pool.query("UPDATE filets SET statut = 'chantier', updated_at = NOW() WHERE appro_id = $1 AND statut != 'chantier'", [approId]);
  } catch (e) { /* non bloquant : un souci ici ne doit jamais empêcher l'appro elle-même d'être sauvegardée */ }
}

async function notify(userId, type, title, body, approId, emailSubject, emailHtml) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, body, appro_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, type, title, body || null, approId || null]
    );
  } catch (e) {
    console.error('Erreur création notification:', e.message);
  }
  // Push (type app) en parallèle — ne bloque jamais.
  sendPush(userId, { title: title, body: body || '', approId: approId || null, type: type });
  // Email en parallèle (ne bloque pas)
  if (emailSubject) {
    try {
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (rows[0] && rows[0].email) {
        sendEmail(rows[0].email, emailSubject, emailHtml);
      }
    } catch (e) {
      console.error('Erreur lookup email:', e.message);
    }
  }
}

// Envoie une notification push à tous les appareils abonnés d'un utilisateur.
async function sendPush(userId, payload) {
  if (!PUSH_ENABLED || !userId) return;
  try {
    const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    if (!rows.length) return;
    const data = JSON.stringify({
      title: payload.title || 'AppROVISIO',
      body: payload.body || '',
      approId: payload.approId || null,
      type: payload.type || ''
    });
    for (const sub of rows) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, data);
      } catch (err) {
        // 404/410 = abonnement expiré ou révoqué → on le retire proprement.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        } else {
          console.error('Push échec:', err && err.statusCode, err && err.body);
        }
      }
    }
  } catch (e) {
    console.error('sendPush erreur:', e.message);
  }
}

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const FILETS_SEED = [
  {type:'Anti-pigeon',largeur:22.0,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:18.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:17.0,hauteur:14.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:12.5,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:12.5,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:12.5,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:15.0,hauteur:9.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:14.0,hauteur:12.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:13.0,hauteur:11.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:13.0,hauteur:11.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:12.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:12.0,hauteur:9.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:12.0,hauteur:9.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:11.5,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:6.0,hauteur:6.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:6.0,hauteur:6.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:6.0,hauteur:6.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:6.0,hauteur:6.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:6.0,hauteur:6.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Anti-pigeon',largeur:3.0,hauteur:8.0,is_anticute:false,date_achat:null,notes:null},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:13.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:13.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:13.0,hauteur:22.0,is_anticute:true,date_achat:'2015-06-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:23.5,hauteur:4.0,is_anticute:true,date_achat:'2018-03-01',notes:'Neuf · Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:25.0,hauteur:3.0,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:10.0,hauteur:14.0,is_anticute:true,date_achat:'2017-09-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:10.0,hauteur:14.0,is_anticute:true,date_achat:'2017-09-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:10.0,hauteur:14.0,is_anticute:true,date_achat:'2017-09-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:14.0,is_anticute:true,date_achat:'2017-06-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:8.5,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:14.0,hauteur:8.5,is_anticute:true,date_achat:'2017-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.5,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2017-09-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2017-09-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:13.0,hauteur:22.0,is_anticute:true,date_achat:'2018-05-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-05-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-05-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:10.0,hauteur:7.0,is_anticute:true,date_achat:'2018-02-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.9,is_anticute:true,date_achat:'2013-11-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:4.7,hauteur:3.9,is_anticute:true,date_achat:'2013-11-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2017-03-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:18.0,hauteur:6.5,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Avec polyâne · Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Avec polyâne · Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Avec polyâne · Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:13.0,is_anticute:true,date_achat:'2019-07-01',notes:'Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:4.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:4.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:12.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:8.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:8.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:8.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:6.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:21.0,hauteur:6.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:20.0,hauteur:4.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:15.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:15.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:15.0,hauteur:13.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:15.0,hauteur:6.0,is_anticute:true,date_achat:'2017-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:15.0,hauteur:15.0,is_anticute:true,date_achat:'2018-09-01',notes:'Tour Eiffel · Maille 100'},
  {type:'Antichute objet',largeur:11.0,hauteur:5.5,is_anticute:true,date_achat:'2017-03-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:4.0,hauteur:3.0,is_anticute:true,date_achat:'2017-02-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:6.0,hauteur:2.7,is_anticute:true,date_achat:'2017-03-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:13.0,hauteur:4.5,is_anticute:true,date_achat:'2017-03-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:13.0,hauteur:4.5,is_anticute:true,date_achat:'2017-03-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:13.0,hauteur:4.5,is_anticute:true,date_achat:'2017-03-01',notes:'Neuf · Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:7.0,hauteur:2.0,is_anticute:true,date_achat:'2018-04-01',notes:'Maille 50'},
  {type:'Antichute objet',largeur:9.0,hauteur:1.5,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2018-07-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:20.0,hauteur:5.0,is_anticute:true,date_achat:'2018-06-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2018-08-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:10.0,hauteur:3.0,is_anticute:true,date_achat:'2011-10-01',notes:'Maille 100'},
  {type:'Antichute homme',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2014-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:5.0,hauteur:4.0,is_anticute:true,date_achat:'2014-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2015-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2015-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:11.0,hauteur:9.0,is_anticute:true,date_achat:'2015-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:6.0,hauteur:9.0,is_anticute:true,date_achat:'2016-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:11.0,hauteur:8.0,is_anticute:true,date_achat:'2017-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:22.0,hauteur:8.0,is_anticute:true,date_achat:'2017-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:8.0,hauteur:20.0,is_anticute:true,date_achat:'2017-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:15.0,hauteur:13.0,is_anticute:true,date_achat:'2017-02-01',notes:'Maille 50'},
  {type:'Antichute homme',largeur:10.0,hauteur:3.0,is_anticute:true,date_achat:'2017-02-01',notes:'Maille 50'}
];

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name          VARCHAR(100) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'conducteur',
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code        VARCHAR(40) PRIMARY KEY,
      role        VARCHAR(20) NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      used_by     UUID REFERENCES users(id) ON DELETE SET NULL,
      used_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appros (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      data        JSONB NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      type        VARCHAR(30) NOT NULL,
      title       VARCHAR(160) NOT NULL,
      body        VARCHAR(400),
      appro_id    UUID,
      is_read     BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_lists (
      name        VARCHAR(40) PRIMARY KEY,
      data        JSONB NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS appro_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID,
      type        VARCHAR(30) NOT NULL,
      actor_name  VARCHAR(160),
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS filets (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type              VARCHAR(80),
      largeur           NUMERIC NOT NULL,
      hauteur           NUMERIC NOT NULL,
      statut            VARCHAR(20) NOT NULL DEFAULT 'depot',
      appro_id          UUID,
      no_affaire        VARCHAR(80),
      notes             TEXT,
      date_achat        DATE,
      is_anticute       BOOLEAN NOT NULL DEFAULT FALSE,
      date_certification DATE,
      date_expiration   DATE,
      created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appro_team_leaders (
      appro_id    UUID,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (appro_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS appro_comments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID NOT NULL,
      user_id     UUID,
      author_name VARCHAR(160) NOT NULL,
      author_role VARCHAR(30),
      body        VARCHAR(2000) NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appro_signatures (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appro_id    UUID NOT NULL,
      user_id     UUID,
      author_name VARCHAR(160) NOT NULL,   -- le nom du compte connecté (rempli automatiquement, jamais tapé)
      signed_name VARCHAR(160) NOT NULL,   -- conservé = author_name, pour compatibilité avec l'historique existant
      signature_image TEXT,                -- le tracé, en PNG (data URL) — la vraie signature demandée par Su
      comment     VARCHAR(1000),
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    /* Jusqu'où chacun a lu la discussion d'une appro.
       Permet de dire « c'est lu » SANS répondre : sinon, pour faire disparaître
       « en attente », il faudrait répondre — ce qui remettrait l'autre en attente,
       et ainsi de suite sans fin. */
    CREATE TABLE IF NOT EXISTS appro_reads (
      appro_id    UUID NOT NULL,
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      read_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (appro_id, user_id)
    );

    /* Articles que CET utilisateur tape souvent, même absents du catalogue.
       Alimente l'autocomplétion « redondance personnelle » : taper "SC" propose
       "Scellement chimique" si c'est un article que la personne saisit fréquemment,
       indépendamment de ce qui existe dans le catalogue partagé. */
    CREATE TABLE IF NOT EXISTS user_frequent_items (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Quantité que CET utilisateur choisit d'habitude pour un article du catalogue
       (ex. il prend toujours 2 mousquetons). Mémorisée par nom d'article, réutilisée
       comme quantité par défaut la prochaine fois qu'il le sélectionne. */
    CREATE TABLE IF NOT EXISTS user_qty_prefs (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Articles \u00e9pingl\u00e9s MANUELLEMENT par l'utilisateur (favoris), ind\u00e9pendants de la
       fr\u00e9quence d'usage automatique \u2014 ex. « je sais que je vais en avoir besoin sur
       ce chantier », m\u00eame si l'article n'a jamais \u00e9t\u00e9 utilis\u00e9 avant. */
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    /* Suggestions d'ajout au catalogue PARTAG\u00c9 : quand quelqu'un tape souvent un
       article absent du catalogue, on propose \u00e0 l'admin/d\u00e9p\u00f4t de l'y ajouter d'un
       clic, au lieu qu'il ait \u00e0 deviner ce qui manque. */
    CREATE TABLE IF NOT EXISTS catalogue_suggestions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name              VARCHAR(160) NOT NULL,
      suggested_by_name VARCHAR(160),
      count             INT DEFAULT 1,
      status            VARCHAR(20) DEFAULT 'pending',
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    );
  `);
  // Ajout de la colonne email si elle n'existe pas déjà (migration douce)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(160);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS news_seen INT DEFAULT 0;`);
  // La signature est passée d'un nom tapé à un vrai tracé (Su) : la table existant déjà
  // en production, CREATE TABLE IF NOT EXISTS ne suffit pas à ajouter la colonne.
  await pool.query(`ALTER TABLE appro_signatures ADD COLUMN IF NOT EXISTS signature_image TEXT;`);
  // Certification des filets anti-chute (Su : "savoir s'ils sont encore certifiés
  // ou non, pour les antichute homme") — la table filets existe déjà en
  // production depuis le tour précédent, il faut donc l'ALTER, pas juste le
  // CREATE TABLE IF NOT EXISTS qui ne touche pas une table déjà créée.
  await pool.query(`ALTER TABLE filets ADD COLUMN IF NOT EXISTS is_anticute BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE filets ADD COLUMN IF NOT EXISTS date_certification DATE;`);
  await pool.query(`ALTER TABLE filets ADD COLUMN IF NOT EXISTS date_expiration DATE;`);
  await pool.query(`ALTER TABLE filets ADD COLUMN IF NOT EXISTS date_achat DATE;`);
  // Import automatique du stock de filets existant (Su : "tu peux pas
  // intégrer tout ça sans que je n'aie à le faire ?") — se déclenche UNE
  // SEULE FOIS. Marqueur dédié dans app_lists plutôt que "la table est
  // vide" : un simple filet ajouté à la main avant le déploiement aurait
  // suffi à bloquer l'import pour toujours, en silence, sans que personne
  // ne puisse s'en rendre compte (exactement ce qui explique le rapport de
  // Su : "l'écran s'ouvre mais le tableau est vide").
  try {
    const { rows: marker } = await pool.query(`SELECT 1 FROM app_lists WHERE name = 'filets_seeded'`);
    if (!marker.length && FILETS_SEED.length) {
      let ok = 0, failed = 0;
      for (const f of FILETS_SEED) {
        try {
          await pool.query(
            `INSERT INTO filets (type, largeur, hauteur, statut, is_anticute, date_achat, notes) VALUES ($1,$2,$3,'depot',$4,$5,$6)`,
            [f.type, f.largeur, f.hauteur, f.is_anticute, f.date_achat, f.notes]
          );
          ok++;
        } catch (e) { failed++; console.error('Import filet échoué (ligne ignorée) :', e.message); }
      }
      await pool.query(`INSERT INTO app_lists (name, data) VALUES ('filets_seeded', $1) ON CONFLICT (name) DO NOTHING`, [JSON.stringify({ at: new Date().toISOString(), ok, failed })]);
      console.log(`Stock de filets importé : ${ok} filets (${failed} échecs).`);
    }
  } catch (e) { console.error('Import des filets échoué (non bloquant) :', e.message); }
  // Fusion des rôles terrain : "team_leader" (comptes créés via lien/QR) n'existe
  // plus en tant que catégorie séparée, tout devient "technicien". Leur accès
  // reste inchangé : il dépend désormais de la table appro_team_leaders, pas du
  // nom du rôle (voir technicienCanAccess). Migration idempotente, sans risque
  // à rejouer à chaque démarrage.
  await pool.query(`UPDATE users SET role = 'technicien' WHERE role = 'team_leader';`);
  console.log('Base de données prête.');
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis' });
  next();
}

function adminOrDepot(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'depot') return res.status(403).json({ error: 'Accès administrateur ou dépôt requis' });
  next();
}

// Écriture des listes : admin/dépôt partout ; le conducteur peut aussi écrire la liste "commandes".
function listWriteAccess(req, res, next) {
  const role = req.user.role;
  if (role === 'admin' || role === 'depot') return next();
  if (role === 'conducteur' && req.params.name === 'commandes') return next();
  return res.status(403).json({ error: 'Accès administrateur ou dépôt requis' });
}

function makeCode(role) {
  const prefix = role === 'admin' ? 'ADM' : role === 'depot' ? 'DEP' : 'CON';
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${rnd}`;
}

// ── AUTH ──────────────────────────────────────────────────────

// Inscription avec code d'invitation
app.post('/api/auth/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, password, name, email, code } = req.body;
    if (!username || !password || !name || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    let role = null;
    // Sans code d'invitation -> role technicien (acces terrain limite)
    if (!code || !String(code).trim()) { role = 'technicien'; } else

    // Cas spécial : code admin bootstrap (uniquement si aucun admin n'existe encore)
    if (code === BOOTSTRAP_ADMIN_CODE) {
      const { rows } = await client.query("SELECT COUNT(*) FROM users WHERE role='admin'");
      if (parseInt(rows[0].count) === 0) {
        role = 'admin';
      } else {
        return res.status(400).json({ error: 'Le code admin par défaut a déjà été utilisé' });
      }
    } else {
      // Code d'invitation classique (à usage unique)
      const { rows } = await client.query('SELECT * FROM invite_codes WHERE code = $1', [code]);
      const invite = rows[0];
      if (!invite) return res.status(400).json({ error: 'Code d\'invitation invalide' });
      if (invite.used_by) return res.status(400).json({ error: 'Ce code a déjà été utilisé' });
      role = invite.role;
    }

    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    let newUser;
    try {
      const ins = await client.query(
        'INSERT INTO users (username, password_hash, name, email, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, name, role',
        [username, hash, name, email, role]
      );
      newUser = ins.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(400).json({ error: 'Cet identifiant est déjà pris' });
      throw e;
    }

    // Marquer le code comme utilisé (sauf bootstrap admin)
    if (code && code !== BOOTSTRAP_ADMIN_CODE && role !== 'technicien') {
      await client.query(
        'UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2',
        [newUser.id, code]
      );
    }
    await client.query('COMMIT');

    const payload = { id: newUser.id, username: newUser.username, role: newUser.role, name: newUser.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rafraîchir le token
app.post('/api/auth/refresh', auth, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name },
    SECRET, { expiresIn: '7d' }
  );
  res.json({ token, user: { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name } });
});

// ── INVITE CODES (admin) ──────────────────────────────────────
app.get('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ic.code, ic.role, ic.used_at, ic.created_at,
             u.name AS used_by_name
      FROM invite_codes ic
      LEFT JOIN users u ON ic.used_by = u.id
      ORDER BY ic.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'conducteur', 'depot'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    let code, ok = false, tries = 0;
    while (!ok && tries < 5) {
      code = makeCode(role);
      try {
        await pool.query('INSERT INTO invite_codes (code, role, created_by) VALUES ($1,$2,$3)', [code, role, req.user.id]);
        ok = true;
      } catch (e) { tries++; }
    }
    if (!ok) return res.status(500).json({ error: 'Impossible de générer le code' });
    res.json({ code, role });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/invites/:code', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM invite_codes WHERE code = $1 AND used_by IS NULL', [req.params.code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── USERS (admin) ─────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, name, email, role, created_at FROM users ORDER BY created_at');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/password', auth, adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/email', auth, adminOnly, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de vous supprimer vous-même' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ACCÈS TERRAIN (rôle unique "technicien") ───────────────────
// Historiquement il existait deux rôles côté terrain : "technicien" (inscrit
// normalement, sans code, accès large filtré côté client par nom) et
// "team_leader" (créé via un lien/QR, restreint aux appros explicitement
// rattachées). Les deux sont désormais fondus dans le seul rôle "technicien" :
// - un technicien inscrit normalement (aucune ligne dans appro_team_leaders)
//   garde l'accès large historique ;
// - un technicien venu d'un lien/QR (au moins une ligne dans appro_team_leaders)
//   reste restreint aux seules appros auxquelles il a été rattaché.
// Cette table interne garde son nom d'origine ; elle ne représente plus qu'un
// mécanisme de rattachement, plus une catégorie de compte.
async function technicienIsRestricted(userId) {
  const { rows } = await pool.query('SELECT 1 FROM appro_team_leaders WHERE user_id = $1 LIMIT 1', [userId]);
  return !!rows[0];
}
async function technicienCanAccess(userId, approId) {
  const { rows } = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM appro_team_leaders WHERE appro_id = $1 AND user_id = $2) AS linked,
       EXISTS(SELECT 1 FROM appro_team_leaders WHERE user_id = $2) AS restricted`,
    [approId, userId]
  );
  const r = rows[0];
  if (!r.restricted) return true; // technicien "ouvert" (inscrit normalement)
  return r.linked; // technicien "lié" (venu d'un lien/QR) : uniquement ses appros liées
}

// ── APPROS (partagées, tous rôles connectés) ──────────────────
app.get('/api/appros', auth, async (req, res) => {
  try {
    if (req.user.role === 'technicien' && await technicienIsRestricted(req.user.id)) {
      const { rows } = await pool.query(
        `SELECT a.id, a.data, a.created_by, a.created_at, a.updated_at
         FROM appros a JOIN appro_team_leaders tl ON tl.appro_id = a.id
         WHERE tl.user_id = $1
         ORDER BY a.updated_at DESC`, [req.user.id]
      );
      return res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
    }
    const { rows } = await pool.query('SELECT id, data, created_by, created_at, updated_at FROM appros ORDER BY updated_at DESC');
    res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
  } catch (e) { res.status(500).json({ error: 'Erreur lecture' }); }
});

// ── ACCÈS PAR LIEN / QR (techniciens terrain) ──────────────────
// Un visiteur non connecté rejoint une appro en donnant son nom → devient technicien
app.post('/api/tl/join', async (req, res) => {
  const client = await pool.connect();
  try {
    const name = (req.body && req.body.name || '').trim();
    const approId = req.body && req.body.approId;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if (!approId) return res.status(400).json({ error: 'Appro manquante' });
    const ap = await client.query('SELECT id FROM appros WHERE id = $1', [approId]);
    if (!ap.rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    await client.query('BEGIN');
    // Créer un compte technicien léger (pseudo unique, pas de mot de passe utilisable)
    const uname = 'tec_' + crypto.randomBytes(4).toString('hex');
    const randomHash = await bcrypt.hash(crypto.randomBytes(8).toString('hex'), 10);
    const ins = await client.query(
      "INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,'technicien') RETURNING id, username, name, role",
      [uname, randomHash, name]
    );
    const u = ins.rows[0];
    await client.query(
      'INSERT INTO appro_team_leaders (appro_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [approId, u.id]
    );
    await client.query('COMMIT');
    logEvent(approId, 'tl_acces', name);
    const payload = { id: u.id, username: u.username, role: u.role, name: u.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '90d' });
    res.json({ token, user: payload, approId: approId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Erreur' });
  } finally { client.release(); }
});
// Un technicien déjà connecté rejoint une nouvelle appro (via un autre lien/QR)
app.post('/api/tl/link', auth, async (req, res) => {
  try {
    if (req.user.role !== 'technicien') return res.status(403).json({ error: 'Réservé aux techniciens' });
    const approId = req.body && req.body.approId;
    if (!approId) return res.status(400).json({ error: 'Appro manquante' });
    const ap = await pool.query('SELECT id FROM appros WHERE id = $1', [approId]);
    if (!ap.rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    await pool.query('INSERT INTO appro_team_leaders (appro_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [approId, req.user.id]);
    logEvent(approId, 'tl_acces', req.user.name);
    res.json({ ok: true, approId: approId });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Récupérer une seule appro (pour ouvrir un lien direct quand on est conducteur/dépôt/admin)
// ═══ MESSAGES EN ATTENTE ═══
// « En attente » = le DERNIER message d'une appro vient de l'autre bord et personne
// n'a répondu depuis. Dès qu'on répond, l'appro sort de la liste. Aucun « lu » à gérer :

// c'est un simple « la balle est dans mon camp », calculé sur le dernier message.
// Deux bords : {depot, admin} d'un côté, {conducteur, technicien} de l'autre.
/* Une appro est « en attente » quand le DERNIER message n'est pas de moi.
   L'ancien découpage par « bord » (dépôt et admin comptés ensemble) faisait qu'un
   compte admin ne voyait jamais les messages du dépôt : sa liste restait vide. */
app.get('/api/appros/pending-messages', auth, async (req, res) => {
  try {
    // Le technicien "lié" (venu d'un lien/QR) ne voit que ses appros rattachées ; les autres voient tout.
    var appros;
    if (req.user.role === 'technicien' && await technicienIsRestricted(req.user.id)) {
      appros = await pool.query(
        `SELECT a.id, a.data FROM appros a
         JOIN appro_team_leaders tl ON tl.appro_id = a.id WHERE tl.user_id = $1`, [req.user.id]);
    } else {
      appros = await pool.query('SELECT id, data FROM appros');
    }
    if (!appros.rows.length) return res.json([]);
    const ids = appros.rows.map(r => r.id);
    // Le dernier message de chaque appro, en une requête (DISTINCT ON).
    const derniers = await pool.query(
      `SELECT DISTINCT ON (appro_id) appro_id, user_id, author_name, author_role, body, created_at
       FROM appro_comments WHERE appro_id = ANY($1)
       ORDER BY appro_id, created_at DESC`, [ids]);
    // Jusqu'où j'ai lu chaque discussion (bouton « J'ai lu »).
    const lus = await pool.query(
      `SELECT appro_id, read_at FROM appro_reads WHERE user_id = $1 AND appro_id = ANY($2)`,
      [req.user.id, ids]);
    const luLe = {};
    lus.rows.forEach(r => { luLe[r.appro_id] = r.read_at; });
    // Combien de messages des autres depuis ma dernière prise de parole OU ma dernière lecture.
    const compte = await pool.query(
      `SELECT c.appro_id, COUNT(*)::int AS n
         FROM appro_comments c
        WHERE c.appro_id = ANY($1)
          AND c.user_id IS DISTINCT FROM $2
          AND c.created_at > GREATEST(
                COALESCE((SELECT MAX(m.created_at) FROM appro_comments m
                           WHERE m.appro_id = c.appro_id AND m.user_id = $2),
                         '-infinity'::timestamp),
                COALESCE((SELECT r.read_at FROM appro_reads r
                           WHERE r.appro_id = c.appro_id AND r.user_id = $2),
                         '-infinity'::timestamp))
        GROUP BY c.appro_id`, [ids, req.user.id]);
    const nParAppro = {};
    compte.rows.forEach(r => { nParAppro[r.appro_id] = r.n; });
    const parAppro = {};
    derniers.rows.forEach(r => { parAppro[r.appro_id] = r; });
    const out = [];
    appros.rows.forEach(a => {
      const last = parAppro[a.id];
      if (!last) return;                                   // aucune discussion
      if (last.user_id && last.user_id === req.user.id) return; // j'ai le dernier mot
      // J'ai marqué comme lu après le dernier message : plus rien à traiter.
      const lu = luLe[a.id];
      if (lu && new Date(lu) >= new Date(last.created_at)) return;
      const d = a.data || {};
      out.push({
        _id: a.id,
        nomChantier: d.nomChantier || 'Sans titre',
        noAffaire: d.noAffaire || '',
        auteur: last.author_name,
        role: last.author_role,
        extrait: last.body.length > 120 ? last.body.slice(0, 120) + '\u2026' : last.body,
        at: last.created_at,
        nonLus: nParAppro[a.id] || 1
      });
    });
    // le plus récent d'abord
    out.sort((x, y) => new Date(y.at) - new Date(x.at));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur', detail: e.message }); }
});

app.get('/api/appros/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, data, created_by, updated_at FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Acc\u00e8s refus\u00e9' });
    }
    res.json({ ...rows[0].data, _id: rows[0].id, _createdBy: rows[0].created_by, _updatedAt: rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Liste des techniciens li\u00e9s \u00e0 une appro via un lien/QR (visible par les comptes internes)
app.get('/api/appros/:id/team-leaders', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.name, tl.created_at FROM appro_team_leaders tl JOIN users u ON u.id = tl.user_id
       WHERE tl.appro_id = $1 ORDER BY tl.created_at ASC`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── FIL DE DISCUSSION PAR APPRO (conducteur ↔ dépôt) ──────────────
// Stocké dans sa propre table : jamais dans le JSON de l'appro, pour ne pas
// être écrasé quand les deux côtés enregistrent l'appro en même temps.
app.get('/api/appros/:id/comments', auth, async (req, res) => {
  try {
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `SELECT id, user_id, author_name, author_role, body, created_at
         FROM appro_comments WHERE appro_id = $1 ORDER BY created_at ASC`, [req.params.id]
    );
    // Qui a lu, et jusqu'à quand : sert à afficher « Lu par … » sous les messages.
    const lus = await pool.query(
      `SELECT r.user_id, u.name, u.role, r.read_at
         FROM appro_reads r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.appro_id = $1`, [req.params.id]);
    const moi = await pool.query(
      'SELECT read_at FROM appro_reads WHERE appro_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({
      messages: rows,
      lectures: lus.rows,
      maLecture: moi.rows[0] ? moi.rows[0].read_at : null
    });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

/* « J'ai lu » — marque la discussion comme lue jusqu'à maintenant, SANS répondre.
   Indispensable : sans ça, le seul moyen de sortir de « Messages en attente »
   serait de répondre, ce qui mettrait l'autre en attente à son tour, sans fin. */
app.post('/api/appros/:id/read', auth, async (req, res) => {
  try {
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `INSERT INTO appro_reads (appro_id, user_id, read_at) VALUES ($1,$2,NOW())
       ON CONFLICT (appro_id, user_id) DO UPDATE SET read_at = NOW()
       RETURNING read_at`, [req.params.id, req.user.id]);
    res.json({ ok: true, read_at: rows[0] && rows[0].read_at });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── ARTICLES FRÉQUENTS PERSONNELS (autocomplétion « redondance ») ──
// Chaque compte a sa propre liste, alimentée par ce qu'il tape effectivement dans
// ses appros — même des articles absents du catalogue partagé.
app.get('/api/my/frequent-items', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_frequent_items WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/frequent-items/bump', auth, async (req, res) => {
  try {
    const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
    if (!names.length) return res.json({ ok: true });
    const { rows } = await pool.query('SELECT data FROM user_frequent_items WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const now = new Date().toISOString();
    names.slice(0, 60).forEach(raw => {
      // Accepte une simple chaîne (ancien format) ou {n, sec} pour retenir la
      // section d'origine (utile pour un ajout rapide direct plus tard).
      const isObj = raw && typeof raw === 'object';
      const n = ('' + (isObj ? raw.n : raw)).trim().slice(0, 120);
      const sec = isObj && ['consommables', 'fournitures', 'outillage'].includes(raw.sec) ? raw.sec : null;
      if (!n) return;
      const key = n.toLowerCase();
      const found = list.find(x => (x.n || '').toLowerCase() === key);
      if (found) { found.c = (found.c || 1) + 1; found.t = now; if (sec) found.sec = sec; }
      else list.push({ n, c: 1, t: now, sec: sec || 'consommables' });
    });
    // On garde les plus utilisés, plafonné pour rester léger.
    list.sort((a, b) => (b.c || 0) - (a.c || 0));
    list = list.slice(0, 150);
    await pool.query(
      `INSERT INTO user_frequent_items (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── QUANTITÉS PRÉFÉRÉES PERSONNELLES ──
// Ce que CET utilisateur choisit d'habitude pour un article donné (ex. toujours 2
// mousquetons) : réutilisé comme quantité par défaut à la prochaine sélection.
app.get('/api/my/qty-prefs', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_qty_prefs WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/qty-prefs/set', auth, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok: true });
    const { rows } = await pool.query('SELECT data FROM user_qty_prefs WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const now = new Date().toISOString();
    items.slice(0, 60).forEach(it => {
      const n = ('' + (it && it.n || '')).trim().slice(0, 120);
      const q = ('' + (it && it.q != null ? it.q : '')).trim().slice(0, 20);
      if (!n || !q) return;
      const key = n.toLowerCase();
      const found = list.find(x => (x.n || '').toLowerCase() === key);
      if (found) { found.q = q; found.t = now; }
      else list.push({ n, q, t: now });
    });
    list.sort((a, b) => new Date(b.t) - new Date(a.t));
    list = list.slice(0, 200);
    await pool.query(
      `INSERT INTO user_qty_prefs (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── FAVORIS PERSONNELS (épingle manuelle, indépendante de la fréquence) ──
app.get('/api/my/favorites', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM user_favorites WHERE user_id = $1', [req.user.id]);
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/my/favorites/toggle', auth, async (req, res) => {
  try {
    const name = ('' + (req.body && req.body.name || '')).trim().slice(0, 160);
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const { rows } = await pool.query('SELECT data FROM user_favorites WHERE user_id = $1', [req.user.id]);
    let list = rows[0] ? rows[0].data : [];
    if (!Array.isArray(list)) list = [];
    const key = name.toLowerCase();
    const idx = list.findIndex(x => (x || '').toLowerCase() === key);
    let on;
    if (idx >= 0) { list.splice(idx, 1); on = false; }
    else { list.push(name); on = true; }
    await pool.query(
      `INSERT INTO user_favorites (user_id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [req.user.id, JSON.stringify(list)]);
    res.json({ ok: true, on, data: list });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── SUGGESTIONS D'AJOUT AU CATALOGUE PARTAGÉ ──
// N'importe quel compte peut déclencher une suggestion (elle vient de son usage
// personnel) ; seuls admin/dépôt peuvent la consulter et l'approuver/rejeter.
app.post('/api/catalogue-suggestions', auth, async (req, res) => {
  try {
    const name = ('' + (req.body && req.body.name || '')).trim().slice(0, 160);
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const key = normCatName(name);
    const existing = await pool.query('SELECT id, status, count, name FROM catalogue_suggestions WHERE name IS NOT NULL');
    const match = existing.rows.find(r => normCatName(r.name) === key);
    if (match) {
      // Une suggestion déjà tranchée (approuvée/rejetée) reste telle quelle : on ne
      // la relance pas dans les jambes de l'admin à chaque nouvelle utilisation.
      if (match.status === 'pending') {
        await pool.query(
          'UPDATE catalogue_suggestions SET count = count + 1, suggested_by_name = $2, updated_at = NOW() WHERE id = $1',
          [match.id, req.user.name]);
      }
      return res.json({ ok: true });
    }
    // Le client vérifie déjà que l'article n'est pas au catalogue avant d'envoyer
    // la suggestion, mais sur sa copie locale — qui peut être périmée si quelqu'un
    // vient de l'ajouter entre-temps. On revérifie côté serveur, sur les données réelles.
    const catRows = await pool.query("SELECT data FROM app_lists WHERE name = 'catalogue'");
    const catalogue = (catRows.rows[0] && Array.isArray(catRows.rows[0].data)) ? catRows.rows[0].data : [];
    if (catalogue.some(it => it && normCatName(it.n) === key)) {
      return res.json({ ok: true, alreadyPresent: true });
    }
    await pool.query(
      `INSERT INTO catalogue_suggestions (name, suggested_by_name, count, status) VALUES ($1,$2,1,'pending')`,
      [name, req.user.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.get('/api/catalogue-suggestions', auth, adminOrDepot, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, suggested_by_name, count, created_at FROM catalogue_suggestions
        WHERE status = 'pending' ORDER BY count DESC, created_at ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Normalisation partagée avec le front (_cpNorm côté client) : accents, casse et
// espaces ignorés, pour comparer deux noms d'articles de façon fiable.
function normCatName(s) {
  return ('' + (s || ''))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
app.post('/api/catalogue-suggestions/:id/approve', auth, adminOrDepot, async (req, res) => {
  try {
    const sug = await pool.query('SELECT name FROM catalogue_suggestions WHERE id = $1', [req.params.id]);
    if (!sug.rows[0]) return res.status(404).json({ error: 'Suggestion introuvable' });
    const name = sug.rows[0].name;
    const catRows = await pool.query("SELECT data FROM app_lists WHERE name = 'catalogue'");
    const catalogue = (catRows.rows[0] && Array.isArray(catRows.rows[0].data)) ? catRows.rows[0].data : [];
    const nameKey = normCatName(name);
    // Déjà présent dans le catalogue (ajouté depuis entre-temps, par Excel, ou sous
    // une casse/accent différent) : on ne duplique pas, on marque juste traité.
    if (catalogue.some(it => it && normCatName(it.n) === nameKey)) {
      await pool.query("UPDATE catalogue_suggestions SET status = 'approved', updated_at = NOW() WHERE id = $1", [req.params.id]);
      return res.json({ ok: true, catalogue, alreadyPresent: true });
    }
    const item = {
      cat: ('' + (req.body && req.body.cat || 'Divers')).trim().slice(0, 80),
      sec: ['consommables', 'fournitures', 'outillage'].includes(req.body && req.body.sec) ? req.body.sec : 'consommables',
      n: name,
      q: ('' + (req.body && req.body.q || '1')).trim().slice(0, 20) || '1'
    };
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ('catalogue', $1::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $1::jsonb`,
      [JSON.stringify([item])]);
    await pool.query("UPDATE catalogue_suggestions SET status = 'approved', updated_at = NOW() WHERE id = $1", [req.params.id]);
    const { rows } = await pool.query("SELECT data FROM app_lists WHERE name = 'catalogue'");
    res.json({ ok: true, catalogue: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/catalogue-suggestions/:id/reject', auth, adminOrDepot, async (req, res) => {
  try {
    await pool.query("UPDATE catalogue_suggestions SET status = 'rejected', updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});



// ═══ SIGNATURE DE FIN DE VISITE (technicien) ═══
// Une seule fois par visite, quand le technicien quitte l'appro après y avoir
// changé quelque chose (ajout d'article, prise en charge...). Prouve que la
// personne qui a manipulé le matériel est bien celle qui l'assume.
app.post('/api/appros/:id/signatures', auth, async (req, res) => {
  try {
    // Le nom vient TOUJOURS du compte connecté — plus de champ à taper (Su :
    // "il doit se remplir automatiquement avec le compte"). signed_name est
    // conservé pour ne pas casser l'historique déjà écrit, mais vaut
    // désormais systématiquement le nom du compte.
    const signedName = req.user.name;
    const comment = ('' + ((req.body && req.body.comment) || '')).trim();
    const sigImage = ('' + ((req.body && req.body.signature_image) || '')).trim();
    if (!sigImage) return res.status(400).json({ error: 'Signature vide — dessinez avant de confirmer' });
    if (!sigImage.startsWith('data:image/')) return res.status(400).json({ error: 'Format de signature invalide' });
    if (sigImage.length > 500000) return res.status(400).json({ error: 'Signature trop volumineuse' });
    if (comment.length > 1000) return res.status(400).json({ error: 'Commentaire trop long (1000 caractères max)' });
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const ins = await pool.query(
      `INSERT INTO appro_signatures (appro_id, user_id, author_name, signed_name, signature_image, comment)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, user_id, author_name, signed_name, signature_image, comment, created_at`,
      [req.params.id, req.user.id, req.user.name, signedName, sigImage, comment || null]
    );
    const sig = ins.rows[0];

    // Prévenir le conducteur et le dépôt : une signature avec commentaire
    // signale souvent qu'il manque quelque chose, ça mérite d'être vu vite.
    try {
      const ap = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
      const chantier = (ap.rows[0] && ap.rows[0].data && ap.rows[0].data.nomChantier) || 'une appro';
      const dest = new Set();
      if (ap.rows[0] && ap.rows[0].created_by) dest.add(ap.rows[0].created_by);
      const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      depots.rows.forEach(d => dest.add(d.id));
      dest.delete(req.user.id);
      const titre = (comment ? 'Signature avec commentaire — ' : 'Signature — ') + chantier;
      const corps = req.user.name + ' a signé' + (comment ? (' : ' + (comment.length > 100 ? comment.slice(0, 97) + '…' : comment)) : '.');
      const mailHtml = '<p><b>' + req.user.name + '</b> a signé son passage sur <b>' + chantier + '</b>.</p>' + (comment ? '<blockquote>' + comment + '</blockquote>' : '');
      dest.forEach(uid => notify(uid, 'appro_signature', titre, corps, req.params.id, 'AppROVISIO — ' + titre, mailHtml));
    } catch (e) { console.error('Notif signature:', e.message); }

    res.json(sig);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ═══ PRÉSENCE (qui regarde cette appro en ce moment) ═══
// Éphémère par nature — pas de table, juste une carte en mémoire nettoyée au fil
// de l'eau. Un seul appel fait à la fois le "je suis toujours là" et le "qui
// d'autre est là" : le client n'a qu'un battement de cœur à gérer, pas deux
// mécanismes séparés.
const _presence = new Map(); // appro_id -> Map(user_id -> {name, role, lastSeen})
const PRESENCE_STALE_MS = 45000;
app.post('/api/appros/:id/presence', auth, (req, res) => {
  const apId = req.params.id;
  if (!_presence.has(apId)) _presence.set(apId, new Map());
  const m = _presence.get(apId);
  m.set(req.user.id, { name: req.user.name, role: req.user.role, lastSeen: Date.now() });
  const now = Date.now();
  const others = [];
  m.forEach((v, uid) => {
    if (uid === req.user.id) return;
    if (now - v.lastSeen > PRESENCE_STALE_MS) { m.delete(uid); return; }
    others.push({ name: v.name, role: v.role });
  });
  if (m.size === 0) _presence.delete(apId);
  res.json({ others });
});
// Départ explicite (ferme l'appro, se déconnecte) : pas obligatoire pour que ça
// fonctionne (l'expiration s'en charge de toute façon), juste plus honnête —
// sinon quelqu'un qui vient de partir semble encore présent jusqu'à 45s.
app.post('/api/appros/:id/presence/leave', auth, (req, res) => {
  const m = _presence.get(req.params.id);
  if (m) { m.delete(req.user.id); if (m.size === 0) _presence.delete(req.params.id); }
  res.json({ ok: true });
});

app.get('/api/appros/:id/signatures', auth, async (req, res) => {
  try {
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const { rows } = await pool.query(
      `SELECT id, user_id, author_name, signed_name, signature_image, comment, created_at
         FROM appro_signatures WHERE appro_id = $1 ORDER BY created_at DESC`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/appros/:id/comments', auth, async (req, res) => {
  try {
    const body = (req.body && req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message vide' });
    if (body.length > 2000) return res.status(400).json({ error: 'Message trop long' });
    if (req.user.role === 'technicien' && !(await technicienCanAccess(req.user.id, req.params.id))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const ins = await pool.query(
      `INSERT INTO appro_comments (appro_id, user_id, author_name, author_role, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, author_name, author_role, body, created_at`,
      [req.params.id, req.user.id, req.user.name, req.user.role, body]
    );
    const msg = ins.rows[0];

    // Répondre vaut lecture : on avance ma marque de lecture au même instant.
    try {
      await pool.query(
        `INSERT INTO appro_reads (appro_id, user_id, read_at) VALUES ($1,$2,NOW())
         ON CONFLICT (appro_id, user_id) DO UPDATE SET read_at = NOW()`,
        [req.params.id, req.user.id]);
    } catch (e) { console.error('Marque lecture:', e.message); }

    // Notifier les autres intervenants (jamais l'auteur lui-même).
    try {
      const ap = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
      const chantier = (ap.rows[0] && ap.rows[0].data && ap.rows[0].data.nomChantier) || 'une appro';
      const extrait = body.length > 120 ? body.slice(0, 117) + '…' : body;
      const dest = new Set();
      // le créateur de l'appro
      if (ap.rows[0] && ap.rows[0].created_by) dest.add(ap.rows[0].created_by);
      // tous les dépôts (sauf si l'auteur est lui-même dépôt)
      if (req.user.role !== 'depot') {
        const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
        depots.rows.forEach(d => dest.add(d.id));
      }
      // si l'auteur est dépôt, on vise le(s) conducteur(s) via le créateur (déjà ajouté)
      dest.delete(req.user.id); // jamais soi-même
      const titre = 'Nouveau message — ' + chantier;
      const corps = req.user.name + ' : ' + extrait;
      const mailHtml = '<p><b>' + req.user.name + '</b> a écrit sur l\'appro <b>' + chantier + '</b> :</p><blockquote>' + extrait + '</blockquote>';
      dest.forEach(uid => notify(uid, 'appro_message', titre, corps, req.params.id, 'AppROVISIO — Nouveau message', mailHtml));
    } catch (e) { console.error('Notif message:', e.message); }

    res.json(msg);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/appros/:id/comments/:cid', auth, async (req, res) => {
  try {
    // Un auteur peut supprimer son message ; admin peut tout supprimer.
    const c = await pool.query('SELECT user_id FROM appro_comments WHERE id = $1 AND appro_id = $2', [req.params.cid, req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Message introuvable' });
    if (req.user.role !== 'admin' && c.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
    await pool.query('DELETE FROM appro_comments WHERE id = $1', [req.params.cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── INT\u00c9GRATION ALOBEES (lecture seule) ─────────────────────────
// La cl\u00e9 API reste c\u00f4t\u00e9 serveur (variable d'environnement), jamais expos\u00e9e au navigateur.
const ALOBEES_API_KEY = process.env.ALOBEES_API_KEY || '';
const ALOBEES_BASE = process.env.ALOBEES_BASE || 'https://api.alobees.com/api';

// Le navigateur demande si Alobees est configur\u00e9 (pour afficher ou non le bouton)
app.get('/api/alobees/status', auth, (req, res) => {
  res.json({ configured: !!ALOBEES_API_KEY });
});

// Liste des chantiers Alobees (proxy avec cache + recherche c\u00f4t\u00e9 serveur)
let _aloCache = { at: 0, sites: [] };
const ALO_TTL = 10 * 60 * 1000; // 10 minutes

async function alobeesFetchAll() {
  const all = [];
  let skip = 0;
  const pageSize = 500;
  for (let i = 0; i < 60; i++) { // garde-fou : max 30000 chantiers
    const r = await fetch(ALOBEES_BASE + '/site?limit=' + pageSize + '&skip=' + skip, {
      headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY }
    });
    const txt = await r.text();
    if (!r.ok) throw new Error('Alobees ' + r.status + ': ' + txt.slice(0, 200));
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('R\u00e9ponse Alobees illisible'); }
    const list = Array.isArray(j) ? j : (j.data || []);
    for (const s of list) all.push(s);
    const total = (j && j.total != null) ? j.total : all.length;
    skip += pageSize;
    if (list.length < pageSize || all.length >= total) break;
  }
  return all;
}

async function getAlobeesSites() {
  if (_aloCache.sites.length && (Date.now() - _aloCache.at) < ALO_TTL) return _aloCache.sites;
  const sites = await alobeesFetchAll();
  _aloCache = { at: Date.now(), sites };
  return sites;
}

app.get('/api/alobees/sites', auth, async (req, res) => {
  if (!ALOBEES_API_KEY) return res.status(400).json({ error: 'Cl\u00e9 API Alobees non configur\u00e9e (variable ALOBEES_API_KEY)' });
  try {
    const all = await getAlobeesSites();
    const q = ('' + (req.query.q || '')).toLowerCase().trim();
    let filtered = all;
    if (q) {
      // La recherche portait UNIQUEMENT sur le nom, alors que le champ promet
      // « Nom de chantier ou N° d'affaire » : chercher une référence ne renvoyait rien.
      // On couvre désormais nom, référence, client et ville.
      const words = q.split(/\s+/).filter(Boolean);
      filtered = all.filter(function (s) {
        const hay = [s.name, s.nom, s.reference, s.ref, s.customer, s.city, s.zipCode]
          .filter(function (v) { return v != null && v !== ''; })
          .join(' ')
          .toLowerCase();
        // tous les mots doivent être présents : « dupont paris » trouve le bon chantier
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    const lim = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ sites: filtered.slice(0, lim), shown: Math.min(filtered.length, lim), total: filtered.length, grandTotal: all.length });
  } catch (e) { res.status(502).json({ error: 'Erreur de connexion \u00e0 Alobees', detail: e.message }); }
});

// D\u00e9tail d'un chantier Alobees (proxy) \u2014 utile pour r\u00e9cup\u00e9rer client / n\u00b0 affaire / adresse
// Resolution des identifiants utilisateurs Alobees (supervisor_ids, foreman_ids) en noms
let _aloUsers = { at: 0, map: {} };
async function getAloUserMap() {
  if (Object.keys(_aloUsers.map).length && (Date.now() - _aloUsers.at) < ALO_TTL) return _aloUsers.map;
  const map = {};
  const paths = ['/user?limit=500', '/users?limit=500', '/member?limit=500', '/collaborator?limit=500'];
  for (const p of paths) {
    try {
      const r = await fetch(ALOBEES_BASE + p, { headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY } });
      if (!r.ok) continue;
      const j = JSON.parse(await r.text());
      const list = Array.isArray(j) ? j : (j.data || []);
      if (!list.length) continue;
      for (const u of list) {
        const nm = u.name || ((u.firstName || u.firstname || u.first_name || '') + ' ' + (u.lastName || u.lastname || u.last_name || '')).trim() || u.fullName || u.email;
        if (u.id && nm) map[u.id] = nm;
      }
      if (Object.keys(map).length) break;
    } catch (e) {}
  }
  _aloUsers = { at: Date.now(), map };
  return map;
}

app.get('/api/alobees/sites/:id', auth, async (req, res) => {
  if (!ALOBEES_API_KEY) return res.status(400).json({ error: 'Cl\u00e9 API Alobees non configur\u00e9e' });
  try {
    const r = await fetch(ALOBEES_BASE + '/site/' + encodeURIComponent(req.params.id), {
      headers: { 'Authorization': 'APIKey ' + ALOBEES_API_KEY }
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'Alobees a r\u00e9pondu ' + r.status, detail: txt.slice(0, 300) });
    let j; try { j = JSON.parse(txt); } catch (e) { return res.status(502).json({ error: 'R\u00e9ponse Alobees illisible', detail: txt.slice(0, 300) }); }
    const site = Array.isArray(j.data) ? j.data[0] : (j.data || j);
    try {
      if ((site.supervisor_ids && site.supervisor_ids.length) || (site.foreman_ids && site.foreman_ids.length)) {
        const umap = await getAloUserMap();
        site._supervisors = (site.supervisor_ids || []).map(function (id) { return umap[id]; }).filter(Boolean);
        site._foremen = (site.foreman_ids || []).map(function (id) { return umap[id]; }).filter(Boolean);
        site._usersResolved = Object.keys(umap).length;
      }
    } catch (e) { /* resolution non bloquante */ }
    res.json({ site: site });
  } catch (e) { res.status(500).json({ error: 'Erreur de connexion \u00e0 Alobees', detail: e.message }); }
});

app.post('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO appros (data, created_by) VALUES ($1,$2) RETURNING id, created_at',
      [req.body, req.user.id]
    );
    const approId = rows[0].id;
    res.json({ ...req.body, _id: approId });
    logEvent(approId, 'creee', req.user.name);

    // NOTIFICATION : un conducteur a lancé une appro → prévenir les chefs dépôt
    // (uniquement si l'appro est réellement soumise, pas un brouillon vide)
    const chantier = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
    if ((req.user.role === 'conducteur' || req.user.role === 'admin') && !(req.body && req.body.draft)) {
      const depots = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const titre = 'Nouvelle appro à préparer';
      const corps = chantier + ' \u2014 demandée par ' + req.user.name;
      const mailHtml = emailTemplate(
        'Nouvelle appro à préparer',
        'Une nouvelle feuille d\'approvisionnement vient d\'être lancée :<br><br><strong>' + chantier + '</strong><br>Demandée par ' + req.user.name + '.',
        'Voir l\'appro'
      );
      for (const d of depots.rows) {
        notify(d.id, 'appro_creee', titre, corps, approId, 'AppROVISIO \u2014 Nouvelle appro à préparer', mailHtml);
      }
    }
  } catch (e) { res.status(500).json({ error: 'Erreur création' }); }
});

app.get('/api/appros/:id/history', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT type, actor_name, created_at FROM appro_events WHERE appro_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/appros/:id', auth, async (req, res) => {
  try {
    // Récupérer l'ancien état pour détecter ce qui change
    const before = await pool.query('SELECT data, created_by FROM appros WHERE id = $1', [req.params.id]);
    const oldData = before.rows[0] ? before.rows[0].data : null;
    const createdBy = before.rows[0] ? before.rows[0].created_by : null;

    // Garde-fou technicien : doit être lié à l'appro (s'il est venu par lien/QR),
    // et ne peut pas finaliser lui-même la fin de chantier ("sortie") — seul le
    // dépôt/admin valide un rendu comme définitivement clos.
    if (req.user.role === 'technicien') {
      if (!(await technicienCanAccess(req.user.id, req.params.id))) return res.status(403).json({ error: 'Accès refusé' });
      if (req.body && req.body.statut === 'sortie') return res.status(403).json({ error: 'Un technicien ne peut pas marquer une appro comme chantier fini — le dépôt doit valider le rendu' });
    }

    await pool.query('UPDATE appros SET data = $1, updated_at = NOW() WHERE id = $2', [req.body, req.params.id]);
    res.json({ ok: true });

    // HISTORIQUE : enregistrer les étapes clés
    {
      const oS = oldData ? oldData.statut : null;
      const nS = req.body ? req.body.statut : null;
      const oM = oldData ? oldData.modifPrep : false;
      const nM = req.body ? req.body.modifPrep : false;
      if (nS === 'prete' && oS !== 'prete') logEvent(req.params.id, 'preparee', req.user.name);
      else if (nS === 'sortie' && oS !== 'sortie') logEvent(req.params.id, 'sortie', req.user.name);
      if (nS === 'sur_chantier' && oS !== 'sur_chantier') { logEvent(req.params.id, 'tl_pris', req.user.name); cascadeFiletsToChantier(req.params.id); }
      if (nS === 'rendu' && oS !== 'rendu') logEvent(req.params.id, 'tl_rendu', req.user.name);
      if (nM && !oM) logEvent(req.params.id, 'modifiee', req.user.name);
      // Un technicien a modifié l'appro depuis le terrain
      if (req.user.role === 'technicien') logEvent(req.params.id, 'tl_modif', req.user.name);
    }
    // NOTIFICATION : passage brouillon → production → prévenir le dépôt
    const wasDraft = oldData ? oldData.draft : false;
    const nowDraft = req.body ? req.body.draft : false;
    if (wasDraft && !nowDraft) {
      const chantierP = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const depotsP = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const mailHtmlP = emailTemplate('Nouvelle appro à préparer',
        'Une appro vient d\'être envoyée en production :<br><br><strong>' + chantierP + '</strong><br>Par ' + req.user.name + '.',
        'Voir l\'appro');
      for (const d of depotsP.rows) {
        notify(d.id, 'appro_creee', 'Nouvelle appro à préparer', chantierP + ' \\u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \\u2014 Nouvelle appro à préparer', mailHtmlP);
      }
    }
    // NOTIFICATION : appro d\u00e9j\u00e0 pr\u00eate modifi\u00e9e par le conducteur \u2192 pr\u00e9venir le d\u00e9p\u00f4t
    const oldModif = oldData ? oldData.modifPrep : false;
    const newModif = req.body ? req.body.modifPrep : false;
    if (newModif && !oldModif && req.user.role !== 'depot') {
      const chantierM = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const depotsM = await pool.query("SELECT id FROM users WHERE role = 'depot'");
      const mailHtmlM = emailTemplate('Ajout sur une appro d\u00e9j\u00e0 pr\u00eate',
        'L\'appro <strong>' + chantierM + '</strong> \u00e9tait d\u00e9j\u00e0 pr\u00eate mais ' + req.user.name + ' vient d\'y ajouter / modifier quelque chose. Un compl\u00e9ment est \u00e0 pr\u00e9parer.',
        'Voir l\'appro');
      for (const d of depotsM.rows) {
        notify(d.id, 'appro_creee', 'Compl\u00e9ment \u00e0 pr\u00e9parer', chantierM + ' \u2014 ajout de ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Compl\u00e9ment \u00e0 pr\u00e9parer', mailHtmlM);
      }
    }

    // NOTIFICATIONS vers le conducteur créateur (sauf si c'est lui-même qui agit)
    if (createdBy && createdBy !== req.user.id) {
      const chantier = (req.body && req.body.nomChantier) ? req.body.nomChantier : 'Sans titre';
      const oldStatut = oldData ? oldData.statut : null;
      const newStatut = req.body ? req.body.statut : null;

      if (newStatut === 'prete' && oldStatut !== 'prete') {
        const mailHtml = emailTemplate('Votre appro est prête au dépôt',
          'Votre appro <strong>' + chantier + '</strong> a été préparée par ' + req.user.name + '. Elle est prête au dépôt.',
          'Voir l\'appro');
        notify(createdBy, 'appro_prete', 'Appro prête au dépôt', chantier + ' \u2014 préparée par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Votre appro est prête', mailHtml);
      } else if (newStatut === 'sortie' && oldStatut !== 'sortie') {
        const mailHtml = emailTemplate('Appro complètement rendue',
          'Votre appro <strong>' + chantier + '</strong> a été marquée comme complètement rendue par ' + req.user.name + '.',
          'Voir l\'appro');
        notify(createdBy, 'appro_rendue', 'Appro complètement rendue', chantier + ' \u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Appro rendue', mailHtml);
      } else if (req.user.role === 'depot') {
        // Le chef dépôt a modifié l'appro (sans changement de statut majeur)
        const mailHtml = emailTemplate('Modification sur votre appro',
          'Le chef dépôt ' + req.user.name + ' a modifié votre appro <strong>' + chantier + '</strong>.',
          'Voir les changements');
        notify(createdBy, 'appro_modifiee', 'Appro modifiée par le dépôt', chantier + ' \u2014 par ' + req.user.name, req.params.id, 'AppROVISIO \u2014 Modification sur votre appro', mailHtml);
      }
    }
  } catch (e) { res.status(500).json({ error: 'Erreur mise à jour' }); }
});

app.delete('/api/appros/:id', auth, async (req, res) => {
  try {
    // Récupère le créateur ET les données (pour comparer au nom inscrit sur l'appro)
    const { rows } = await pool.query('SELECT created_by, data FROM appros WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Appro introuvable' });
    const d = rows[0].data || {};
    const norm = (x) => (x || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const me = norm(req.user.name);
    // Une appro est « la mienne » si mon compte l'a créée, si je suis admin/dépôt,
    // OU si mon NOM figure dessus (conducteur, chargé d'affaires, team leader) —
    // même si elle a été créée depuis un autre compte.
    const nameMatches = me && [d.conducteur, d.chargeAffaires, d.tlName].some((n) => norm(n) === me);
    const allowed = rows[0].created_by === req.user.id
      || req.user.role === 'admin'
      || req.user.role === 'depot'
      || nameMatches;
    if (!allowed) {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres appros' });
    }
    await pool.query('DELETE FROM appros WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
// Liste mes notifications (les 50 plus récentes)
// ── TABLEAU DE BORD (statistiques admin) ──────────────────────
app.get('/api/stats', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT a.data AS data, u.name AS creator FROM appros a LEFT JOIN users u ON a.created_by = u.id'
    );
    const byConductor = {}, byType = {}, materials = {};
    let totalArticles = 0;
    rows.forEach(r => {
      const d = r.data || {};
      const who = (d.conducteur && d.conducteur.trim()) ? d.conducteur.trim() : (r.creator || 'Inconnu');
      byConductor[who] = (byConductor[who] || 0) + 1;
      const types = Array.isArray(d.typeChantiers) ? d.typeChantiers : (d.typeChantier ? [d.typeChantier] : []);
      types.forEach(t => { if (t) byType[t] = (byType[t] || 0) + 1; });
      ['consommables', 'fournitures', 'outillage'].forEach(sec => {
        (Array.isArray(d[sec]) ? d[sec] : []).forEach(it => {
          if (it && it.designation && it.designation.trim()) {
            const k = it.designation.trim();
            materials[k] = (materials[k] || 0) + 1;
            totalArticles++;
          }
        });
      });
    });
    const sortObj = o => Object.keys(o).map(k => ({ name: k, count: o[k] })).sort((a, b) => b.count - a.count);
    res.json({
      totalAppros: rows.length,
      totalArticles: totalArticles,
      byConductor: sortObj(byConductor),
      byType: sortObj(byType),
      topMaterials: sortObj(materials).slice(0, 15)
    });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── LISTES PARTAG\u00c9ES (types / catalogue / clients) ─────────────
const LIST_NAMES = ['types', 'catalogue', 'clients', 'trucks', 'commandes', 'annonces', 'tickets', 'config', 'filet_types'];
// ── FILETS (stock au dépôt + suivi chantier) ─────────────────────────
app.get('/api/filets', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM filets ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.post('/api/filets', auth, async (req, res) => {
  try {
    const { type, largeur, hauteur, statut, appro_id, no_affaire, notes, date_achat, is_anticute, date_certification, date_expiration } = req.body || {};
    const l = parseFloat(largeur), h = parseFloat(hauteur);
    if (!l || !h || l <= 0 || h <= 0) return res.status(400).json({ error: 'Largeur et hauteur doivent être des nombres positifs' });
    const { rows } = await pool.query(
      `INSERT INTO filets (type, largeur, hauteur, statut, appro_id, no_affaire, notes, date_achat, is_anticute, date_certification, date_expiration, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [type || null, l, h, statut || 'depot', appro_id || null, no_affaire || null, notes || null, date_achat || null, !!is_anticute, date_certification || null, date_expiration || null, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erreur de création', detail: e.message }); }
});
app.put('/api/filets/:id', auth, async (req, res) => {
  try {
    const { type, largeur, hauteur, statut, appro_id, no_affaire, notes, date_achat, is_anticute, date_certification, date_expiration } = req.body || {};
    const l = parseFloat(largeur), h = parseFloat(hauteur);
    if (!l || !h || l <= 0 || h <= 0) return res.status(400).json({ error: 'Largeur et hauteur doivent être des nombres positifs' });
    const { rows } = await pool.query(
      `UPDATE filets SET type=$1, largeur=$2, hauteur=$3, statut=$4, appro_id=$5, no_affaire=$6, notes=$7,
       date_achat=$8, is_anticute=$9, date_certification=$10, date_expiration=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [type || null, l, h, statut || 'depot', appro_id || null, no_affaire || null, notes || null, date_achat || null, !!is_anticute, date_certification || null, date_expiration || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Filet introuvable' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erreur de mise à jour', detail: e.message }); }
});
app.delete('/api/filets/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM filets WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/lists', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name, data FROM app_lists');
    const out = {};
    rows.forEach(r => { out[r.name] = r.data; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Initialiser une liste avec les valeurs par d\u00e9faut (seulement si absente)
app.post('/api/lists/:name/seed', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
    await pool.query(
      'INSERT INTO app_lists (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, JSON.stringify(data)]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Ajouter un \u00e9l\u00e9ment (tout le monde)
app.post('/api/lists/:name/add', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    if (req.body.item === undefined) return res.status(400).json({ error: '\u00c9l\u00e9ment manquant' });
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $2::jsonb`,
      [name, JSON.stringify([req.body.item])]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Ajouter plusieurs \u00e9l\u00e9ments d'un coup (tout le monde)
app.post('/api/lists/:name/addmany', auth, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: 'Aucun \u00e9l\u00e9ment' });
    await pool.query(
      `INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = app_lists.data || $2::jsonb`,
      [name, JSON.stringify(items)]
    );
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Remplacer toute une liste (admin uniquement) \u2014 utilis\u00e9 pour les camions
app.post('/api/lists/:name/set', auth, listWriteAccess, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
    await pool.query(
      'INSERT INTO app_lists (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET data = $2::jsonb',
      [name, JSON.stringify(data)]
    );
    if (name === 'config') invalidateMailCfgCache(); // le réglage email prend effet immédiatement
    res.json({ data: data });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Supprimer un \u00e9l\u00e9ment par index (admin uniquement)
app.post('/api/lists/:name/remove', auth, adminOrDepot, async (req, res) => {
  try {
    const name = req.params.name;
    if (!LIST_NAMES.includes(name)) return res.status(400).json({ error: 'Liste inconnue' });
    const idx = parseInt(req.body && req.body.index, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Index invalide' });
    await pool.query('UPDATE app_lists SET data = data - $1::int WHERE name = $2', [idx, name]);
    const { rows } = await pool.query('SELECT data FROM app_lists WHERE name = $1', [name]);
    res.json({ data: rows[0] ? rows[0].data : [] });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── CONDUCTEURS (liste pour menu d\u00e9roulant) ──────────────────
app.post('/api/alobees/refresh', auth, adminOnly, (req, res) => {
  _aloCache = { at: 0, sites: [] };
  _aloUsers = { at: 0, map: {} };
  res.json({ ok: true });
});

app.get('/api/users/names', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.get('/api/users/conductors', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name FROM users WHERE role IN ('conducteur','admin') ORDER BY name"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── NOUVEAUT\u00c9S (journal des mises \u00e0 jour) ─────────────────────
app.get('/api/news/seen', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT news_seen FROM users WHERE id = $1', [req.user.id]);
    res.json({ seen: rows[0] ? (rows[0].news_seen || 0) : 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
app.put('/api/news/seen', auth, async (req, res) => {
  try {
    const v = parseInt(req.body && req.body.version, 10) || 0;
    await pool.query('UPDATE users SET news_seen = $1 WHERE id = $2', [v, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type, title, body, appro_id, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// Marquer une notification comme lue
app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// Marquer toutes mes notifications comme lues
app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── WEB PUSH : clé publique + abonnement/désabonnement ──
// Expose la clé publique VAPID (le client en a besoin pour s'abonner).
app.get('/api/push/key', (req, res) => {
  res.json({ enabled: PUSH_ENABLED, key: PUSH_ENABLED ? VAPID_PUBLIC_KEY : '' });
});
// Enregistre (ou met à jour) l'abonnement push de l'appareil courant.
app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
    if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push désactivé' });
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Abonnement invalide' });
    }
    // upsert par endpoint (un même appareil ne crée qu'une ligne, rattachée à l'utilisateur courant)
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});
// Retire l'abonnement de cet appareil.
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── PWA : manifest + service worker servis en inline (pas de fichiers à déposer) ──
const PWA_ACCENT = '#123528';  // vert JARNIAS — remplace l'ancien violet générique
// Icônes PWA : le VRAI logo JARNIAS (le même que .png embarqué dans l'app, LB64),
// pas une icône générique. Trois variantes générées à partir de ce logo :
//  - "any" 192/512 : remplit presque tout le cadre (96%), pour les contextes
//    qui n'appliquent aucun découpage (Windows, favoris, etc.)
//  - "maskable" 512 : marge de sécurité généreuse (70%) pour survivre à un
//    découpage rond/squircle sur Android sans perdre un bout du logo.
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'AppROVISIO',
    short_name: 'AppROVISIO', // était "AppRO" — coupé au milieu du nom, corrigé
    description: "Gestion des approvisionnements de chantier — JARNIAS",
    start_url: '/',
    scope: '/',
    // Ouvrir les liens du domaine dans l'app installée plutôt que le navigateur (Android).
    handle_links: 'preferred',
    launch_handler: { client_mode: 'navigate-existing' },
    capture_links: 'existing-client-navigate',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#000000', // noir pur, identique au fond du logo — aucune couture au démarrage
    theme_color: PWA_ACCENT,
    lang: 'fr',
    icons: [
      { src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});
const PWA_PNG_192 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAt+klEQVR42u1deXhURbb/3d47pLNvZCE7IQkkRMjCJhD2JKwjm6iA8GYcEN8TeIDoyDKOzgijIzLgvPH5RGGQRQEhQgibAQxLEmIC2chC9n3vLJ3u9Hl/6L1f3yRAYBAQ6vd99yN0365bt6p+VeecOucUB4DAwPCUQsKagIERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEYCBgRGAgYERgIGBEeDXBI7jIJPJwHEca4yH2e4AiDXDI56FJBIYjUbWEGwFeHoHf58+fbB8+XL4+/sLKwLDwwGx69FcEomEAJCfnx8dO3aMiIgiIyNF37HrF79YIzzKwT927Fi6fPkyERE1NjZSeHg4I8DD7Ae2AD46sScyMhLLli0DAFRUVEAikUAqlbIGeoiQsSZ4NIM/KCgIU6dORUVFBTo7OyGXy9GvXz8olUrWSIwAT66p02g0QqPRYPLkyaiqqoJGo4FCoUBFRQXUajVTfhkBnmwCEBFGjBgBvV6Pjo4OSKVSKBQK1NTUwNLSkplDmRn0yYXRaIRKpYKHhwe0Wi2ICDqdDq2trWhqakJ9fT1bARgBntzZHwAcHByEHV+9Xg+j0QidTofm5mbU1tZCLpezxmIEeHKhUqmgUqkgkUjAcRwMBgMMBgNaW1vR1tYGIrYxzwjwBMNgMECtVkOhUAhiUUdHBwwGAyMAI8CTj/r6eigUClhbW0Mul0MqlaKzsxN6vR6tra2QyZhdghHgCQQRgeM41NfXo66uDr6+voIoJJFIoNfrYTAYIJGwLmEEeMIV4bNnz8Lb2xve3t5QKpWQyWQgInR2djIRiBHgyYXRaATHcUhNTcWFCxcwYcIE9O3bFwqFAlKpFHq9nplBGQGeDmzduhUVFRWYPHkybGxsIJVKQUTMDMoI8OTrAhKJBJWVlVi2bBlkMhnGjx8Pa2trwTLEwAjwxItCEokEKSkpWLx4MWxtbTFmzBj06dOHiUCMAE8PCaRSKb7//ns8//zzsLW1RWho6E+dwixBjABPAzo7OyGVSnH+/HksXrwYHh4e6Nevn7BCMDwksZRdj/aSyWQEgN544w0qKCigkJAQAkBSqZS1D4sIezoUY6lUipMnT6KpqQkHDhzAsGHDhBWCgYlAT24H/Bwh1tnZiQEDBmDnzp1obm7Gvn37EBYWhs7OTiYOMQI8OeA4TnB/4JVhIsLs2bOh0WiQlJSEQ4cOobGxEbt374a/vz/TCRgBfj2D2/TiBzrv+syLO0ajEUajEXK5HEOGDMGqVaug0WiwZ88ePPvss0hMTMRXX30FjuPw+eefw8nJSdhFZnjAfQaWGe6hwsbGBq6urujfvz9cXV3R0tKCS5cuoba2Fi+++CLS09NRXl6O4cOHQ6FQYPXq1Thz5gxefvlldHZ2spBJRoBHD6lUCqlUKogv/CwvlUohl8shl8uhUChgYWEBS0tLWFtbw9raGhqNBlKpFM3NzSguLkZxcTEkEgmGDh0KLy8vnDp1Cnl5eXj11VfxzTffYMiQIfDw8MBLL72Ed999F59++qkQV8zACPBIRBwiQmRkJAICAtDY2CgSdfi/edmeD3LRarVobm5Ga2sr9Ho9zMzM4OTkBCcnJ3Ach+vXryMrKwt+fn6YPHky/vWvf8HMzAxDhw5FQUEBpk+fDjc3N7zyyisoLS1lJGAEeLQksLS0hJeXF/z9/aHX6wXRhI/xJSLBtCmTySCTyaBWqyGTyWA0GqHValFdXY2amhoYjUZ4enoiICAA9fX1iI2NhaOjI2bPno2dO3di0qRJaG5uxvjx45GQkIC9e/cyAjxAsPCj+0BDQwNKSkrg7u4OlUol2OoVCoUw+HlCdHR0oK2tTRjsEokEZmZmcHFxwYABA6DX61FaWopvvvkGMpkMMTExcHBwwLZt29C/f3+Ym5sjKSkJXl5esLS0hFqtRltbG+sEtgI8elFIoVBg1qxZkMvl0Ol03aw0/P/5+w0GA/R6PbRaLbRaLXQ6HWQyGRwdHeHm5gapVIrU1FSkpaVh9OjRGDJkCLZu3YoZM2agqakJdnZ2iI2NRVVVFVsFGAEePQmkUilsbGwwePBg9O3bF+3t7cKmFq8D8Pfyzm8ymQwKhQJKpRIcx6GtrQ2VlZWorKyETqdD//79ERQUhPLychw8eBDDhg1DSEgIvvjiCyxYsACffvoptFotIwAjwOODoKAg9O/fHyqVCgCE8EY+7Ynp7N/e3o7Ozk50dHRAIpFApVLB2toaVlZWkEgkKCoqwo0bNwAAU6ZMgUajwbZt2zB16lSoVCrs2bOHDX5GgMcHvCuDp6cnxo0bh5aWFiEAntcH+P+bXkQk6AdNTU1obm4GANja2sLX1xdKpRLJycm4evUqpk6dCh8fH+zYsQNarVYgGQMjwGNDAqVSCUdHR4wYMUIU4M6LP12tRFKpFBzHQalUQqlUQiqVoqOjA3V1dSgsLIRWq4WnpyciIiJQXV2Nffv2obW1lTU2I8DjC5VKhbCwMDg5OUEulwv6QFddgP9cr9dDp9NBr9cL8cAWFhZwdHREnz59UFNTg8uXLyM3N1ekTDMwAjzWGD9+PHx9fYUsD7wYZCq6mG6aAUBHRwe0Wi1qa2tRUlKCwsJC6PV6YYUxLYOBEeCxFocUCoWQ9Y1Pf25qIjUYDOjo6BBWB/7vnspiA58R4OnoiJ+VY36VYIOeEeBXP6B7AzbQGQEYGB6dyMqagIERgIGBEYCB4enDI3WH7klRvBel8N/9fU9l3Ul5vVfrzL9Tv9vVo6ffP4h2uJfn3Wu5phauntrzURoCnnol2NT02Ksl8+fIL96l4X6e9zRYfviNvp72N3pq0/uZYH7VBOAjpbrOCB0dHb1uBL4M3ucGAHQ63X01okKhgJmZGczNzYUzvGQyGTo7OwWHtcbGRnR0dIg67nZB6hzHQS6XC5tZEokEOp1OyO5wtzrKZDLI5XLRffx5Yl0HD59V2rQd+Ei1XsvCP/sz8e/DcRw6OjruKwjf9P1UKhW8vb3h4eEBGxsbIaCnvr4eZWVlyMvLQ2Nj49MjAvGD5rnnnsPKlSvR3t4OAJDL5aioqMCrr76K0tLS2w4uvnHd3Nywfft2ODo6Cr40KpUKX3zxBbZv337HwWlazvjx47Fo0SL07dsX9vb20Gg0UKlUIgK0t7ejsbER5eXlyMjIQEJCAhISElBRUdGtw/m/NRoNduzYAV9fX7S3t0OpVOLWrVtYs2YNioqKbksC/vMVK1ZgwYIFggOcUqlERkYGli9fjtbWVuH9AgMDsW3bNigUCoFcHMfhD3/4A86cOXNXkvI+SO+//z5GjhwpRJupVCokJSVh1apVaGtr6/XKxd9nbW2N+fPnY+7cuQgMDISNjY1IDCIiNDc3Iz8/HwkJCfj222+RmJj4SBz+HmouRj7f5dq1a6krqqurydfX96ecjRJJz7kcf/789ddfp56Qm5tLzs7OxHEccRx3+5yQP5fz5z//me4H169fp9///vfC+/DP4v+1tbWlvLy8br87duwYaTQa0b091Wvnzp3dfpuRkUEWFhaifKIjR47ssX7z58+/Yzua9sWIESNIp9N1K6Ozs5PGjx9/13K61n3AgAF07ty5HsvjL6PRKPpOp9PR4sWLH3pO1EdmBeJdg/V6vfB3a2vrHWcZXvbWaDSYOXOmEHXFe1d2dnbC09MT48ePF4kDdwLvh8PXwdRbkz/Dl7/4SC8iQmBgID766CNs3LhRONWl6wzX2toqvCNfXnR0NNauXXtXhVun0wn14uvW0zGqBoMBWq2223N4R7o7znw/lzVr1iwoFApRG+j1ekgkEsyaNatXOhLfN/b29ti+fTtGjx4t9AnfnqYOgaZtzItq5eXlT48ZlFeSeIcx03SBd1OWJk6ciGHDhkEikUAmkwnl8GUuWrQIffr06RUJ+NBG0zrw5fE6Bn/xz+c7WyaT4a233sKqVatEQS+m9TV9R/4YpLVr12LJkiV3THnY9Xe3ax++/l3vv9t786KRj48P5syZI+gd/HN4/WzWrFnw9/cX9Ji7GRPWrVuHcePGCYl9u9ataz1lMhk4jkNycjISEhIEXeepMIPeK2GMRiMUCgUWLlwopBgx7RRe4Rw5ciTGjh2LY8eOCefw9koW/HkQt7e349q1a6ivr4dUKoWFhQVcXFzQr18/oaNNZetVq1YhNjYW6enpQr3u9A4ymQxbt25Ffn4+zp49e1d95ZfE3Llz4erq2m2y4Ovq6OiI+fPn4+233+4VmRYsWNCtrM7OTnz//fdITU1FXV0dFAoFHBwcEBgYiODgYFhYWOC7774T6TaMAD00cmdnJyIiIhAZGXnb2Z1X6l588UUcP378nhqTL7O4uBhz585FcXExZDIZVCoVHB0dMXr0aLz55pvw8vISZsTOzk7Y2dkhJiYG6enpvTYCWFlZ4e9//ztiYmKQn5//UDveVFyZO3euKGyzqzWJiDBnzhzs3LkT5eXlPdaTvzciIgIODg6iZ0gkEnzwwQd4++23BYMHDzMzMzzzzDOYOnUqvv3220czrn4tBOA7Zd68eejTp49g8TAajdi3bx9KSkpE906aNAmDBw++69LdE3jLD/+3VqtFXl4ePvvsM6xYsaKbVYSIMGjQIKE+d3sPfhD5+/vjww8/hFqt7rXO8iD3PqKiojBw4EDRd/Hx8bhy5YpI5vfz88PUqVPvWm7fvn1F7SKRSNDW1oa9e/dCp9MJZmH+am1txYULF7B27VqkpaU9dPHnV0MAfsB4e3tj+vTpou+qqqqwYcMGQX7kZzNLS0vMnz//39JPuv5fIpHg4sWLyMrKEpGS4zg4OjqK7Oh3MxPyq8e0adOwfv36+yLqvzP7K5VKLFiwQDRTExG2b9+OL774otsG4YIFC0QTT28nLaVSibCwMBCRSDHn2643uh9bAX7GzJkz4ezsLBpk586dQ3Z2NmJjY7sNohkzZsDNze2+8uub2vW7/vvvzNSmqwc/6FavXo2pU6c+lMMw+PIjIiIwcuRI0Xc5OTlISEhAXFwcqqurRTu0w4YNw+jRo+9ovaquru7WRhKJBJs3b8arr74KGxsbwcpk+v6PMuP1Y08AfoaysLDAb37zG5EY0dnZiUOHDoHjOJw5cwZZWVmimcvb2xsxMTH3/VzTeF7enBcWFgZfX99uqU+qqqqEXD93ItTu3btx+vRp0W9VKhW2bNkCT09PIYD+lwI/2GbPng21Wi0afLGxsWhoaEBBQQHi4+NFJku5XI65c+cKg7and0tMTERVVZXwHP4dHRwc8PHHH+PUqVPYsGEDQkNDhU1G0wwZjAB3mLHGjBmDZ555RjQzZ2Vl4fTp0wCAiooKHDt2TCQGAcCcOXNgZmZ2z0u3aVoTMzMzODs7Y86cOfjoo4/Qp08fEUk4jkNqauodVxq+Pjdv3sSyZcuE3W5+sPj5+eHdd98V4od/iQHBD0gPDw/RxCCVStHS0oLDhw8L9Tl48KBgyuTrMnnyZPj5+XVbafm2zc7OFqVwNyUBESEkJAQbN27EqVOncOTIEbzwwguwtrYWtTUjQJcO4zOszZ07V0g1wjfUkSNHUFtbK9isv/32W7S0tIgOlouIiMDw4cNFZLqbcuji4oL/+Z//we7du7F//34cO3YM58+fx969ezFgwABR3SQSCUpKSvD111+LBvrtYG5ujpycHLz++uuCOMSXNW/ePPzud7/7xfQBvszo6Gi4u7uLJopLly7hypUrwr0JCQlChjp+kDs4OAgbY7fDX/7yF+zbt0+w+Zs6DfLij4WFBaKiovDll18iPj4eL730kkCUh02Cx54AAODv749x48aJFNLm5mYcPXpU1HDXrl1DSkqKyJqjUqkE0eluqwD/Hb/TvGDBAvzmN7/B2LFj4eXlJTIB8kt3W1sb3njjDeTm5vbKCsQT+sCBA9iyZUu3jv/DH/4Af39/IQPcg55M1Gq1qD14Uhw+fBg6nU4YuLW1tTh58mS3FWzGjBmwtLTs1pb8OzQ1NWHp0qXYtGkTKisrRUpu151gIsKQIUPw+eefY9u2bVCr1XfUMZ5aJTgmJgaOjo6iGSspKQk//vijIJNyHIeWlhbs37+/24CeMmWKMOP1pnF5iwV/mbpAmO4GFxYWYsmSJdi9e/c9dRpfzvvvv49jx46JRCF7e3u8++67sLW1/UUmk7CwMERERIgsWNXV1Th9+nQ3WfzAgQNobm4WXMCJCMHBwRg1alSPA5UvU6vVYuPGjZg4cSLef/99ZGZminasTZ32+E3KV199VbCGsRUAYr+fGTNmdJux9u/fj7a2NsHfRKlUwsHBAZWVldBqtaJOc3d3x8SJE3s9u/CuzPzFd5ypjTs2NhajR48WHVhxL50nkUjQ0tKC1atXo6CgQDRLxsTEYObMmb0S2+7VqjVr1ixB+eU/i4uLQ2ZmpuCbw2e91uv1KCoqEolBcrkcM2fOvK13qCmx0tLSsHbtWkRGRmLOnDn44osvUFVVJRCNX0X5tluxYoWg5z0s06jscSYAAAwfPhzPPPOMSOmsr69HQ0MDZs2ahYEDB8LT0xP9+vWDi4sLHB0dYWZmJiIRx3GYNWsWdu3ahY6OjjtGP3Ech8bGRhw/fhwNDQ3w8PDA5MmTRVYfjuPg5ubWLdntvVpjpFIpsrOz8dZbb2HXrl2C7iKTyWBjY/PA91GcnZ0RFRXVzcqVk5ODCRMmIDg4GF5eXvDw8ICLiwucnJxgbW0tlMG/48SJE+Hl5YW8vLwed4ZNN8J4A8WBAwdw4MABBAQE4D/+4z/wu9/9TtgA5C16lpaWiI6ORkpKykMVg34ZN9PbuM9KpVLiOI7++7//W+QiS0RUXFxMPj4+IpfY7du3ExGRwWAQuc7W19f3ym2Zd7ttaGigsLAwoWy+fn/84x+71SMzM5NsbW0JAPXp04cOHz4s3GP676FDh0itVpNEIunmDm1jY0M3btzoVvbbb78ttA/HcSSVSkkqldLnn38uKtvUXZj/7Nq1a4IrNe8OPWzYMGptbe3229mzZ3d71xdffJGMRmO3suvq6qijo+OubWj697Jly3rsZ47jevyM73f+s5UrV5LBYBDqo9fryWg00meffdZr92s8zu7Q/MzLiw5dM5/Z29v3qCDyu4WdnZ3o27cvJk+e3E10USgUsLKyEtyhu8rrPYlS/OzS29WH94xsaWnBmjVrBDGFF8OMRiOmT5+ORYsW3fcZvqZ7DJs2bUJubq5IRn6QfSGVSjFt2rRuirpEIoG1tTVkMlm3tuTPNuiq7ALA1KlTRUE4pt/zz+t6IDgAQaT817/+hZKSEtGqyrf7r14HUCgU8PDwEGn7pp1tZmYmKFKmqKurQ0NDg/D/yMhIeHt7izrB9AQW3m23q7zOxwh0RXR0NKysrARLzN0GJ++5mZOTg02bNgnkMt2LePPNNxEQEHDfg5Z/j4KCAmzcuPGBb4TxdfLz8xN2ck31DV6H4gefaVvy4aamk4qpaBoSEtJt59fV1RV9+/YV+qhr//OTlEajEUTVnsSnh4UHSjd+9goODsaePXtw5swZ7N27F2lpaYJi6ujoiDVr1iA8PFwk//GyaFNTk9CgvN8PP6N0VQrb2tpQVVWFwsJCFBcXo6ioCKWlpcjLy8OcOXOwePFi0cAMCgrC8OHD8d133/U6YJsfoHv27EFUVBTmzJkjWgVcXFywfv16LFy4sNfxvrezCn311VeIiYnBvHnz7st9404EmDRpEuzt7UXl8pYZ4KcApdraWqEdi4qKUFJSgtzcXPj5+eG9994T7jW15V++fFn0zhs3bsTIkSOxZ88eXLhwAdnZ2aJYaqVSCV9fX6xfvx729vaiMQAAtbW1D9UU+kAJYLr76uvrC19fX7zwwgvIzc1FZWUlpFIpfHx84O7u3mNHnTp1SihjwIABePbZZ0UKGG9ZiI+PR05ODrKyslBYWIja2tpudvOWlhY8//zzUCqVwiwml8sxdepUfPfdd732P+GfazAY8Kc//QljxowRdRwf3/zVV18J8Qf36ttiulH0zjvvYMyYMXB0dHwgJDAYDFCpVIiJiel2Yk1ZWRliY2ORkZGBrKws5Ofno7q6Gg0NDSIS29jYYPHixUJgDI+oqCh88MEHQlC7m5sbJkyYgH79+mHz5s1obW1FWVkZampq0NTUBKPRCGtra/j4+AhmXlMRyGAw4MyZMw99JXggygSv4Hh6etLNmzfJYDCQXq+/o1LFKz9ERFeuXCE7OzuhnNdee024h48hbWtrE2JUe3q+RCIhmUxGEomELCwsKDExkYxGIxkMBqGM7OxscnZ2Fn7XkxKclZVFDg4OovfilbKNGzeKFE5eOT937hz16dNHuK83SjDuEi/N1/nfUYIBUEREBDU2Norak4ho/fr1t21LXjnnn/Pxxx8L78vXq729nSZNmiT8btGiRaTX60mv14uMFj3BtK78GDh8+DCp1eo7xnI/tkowP1PNmTMHPj4+ghLEK1amsbW8HM/LnSUlJXj99ddRU1Mj6BDR0dEiJzQASEtLw6VLl0RKqql93vRkxqamJsTFxXXz2/fx8RFk4a67kqby6u1Wgk8++QQZGRnCu/GbOaNGjcKsWbNEs3/XMu+WS4gXof7xj3/gypUrIvHwTr/tqf5dZ2oLCwuRz019fT1OnDhx27bkdQPTfQ9TZz9+74U3LPBKtmn4aE9x1XwMsOlKJJPJkJiYiJUrVwruIQ8TD3QFCAoKok8//ZQqKyvvaqLU6/V0/PhxCg0NFc2Aw4cPp5aWlm73/+lPf+qViYz/fsSIEcLsaIqvv/5aeNa7777b7fu8vDxydHTslrmB/3vJkiU9vk9ycjLZ2dkJWSFycnK63bN58+ZeZb2YMWNGN9Pk9evXu2WFGDFiRI+zLZ8Vws7OjlJTU7t9f/r0aVIqlXfNnmFq1u2pnNzcXOrbty9xHEfR0dF06NAhqqmp6XV2jcrKStq+fbuwKj/M2R8A/WKJsQIDAzFu3DiEhoaiX79+MDc3h0QiQUdHB2pra5GRkYEzZ87g7NmzaGtrE52G4uXlhZEjR4qUVIlEgvPnz+PWrVu9VjTVajUmTJggWH74TaaamhrEx8ejo6MDYWFhCAsLE8yvMpkMtbW1OHLkSI8nsnMchz59+mDmzJnQaDTCSsbLsEePHkVFRQVUKhWmTZsGe3t7YVWSy+W4dOkSkpKS7vgO/E709OnT4eDgAL1eD7lcjsrKSnz77bfCTMzH7E6bNk3YUeXrEh8fj9zcXFhbW2P8+PFQqVQiU2RGRobI+a03GDVqFLy9vUVHN+n1epw6dUpYvaVSKQICAhAaGoqgoCB4e3vD1tYWKpUKHMdBr9ejsbERhYWFSElJwblz55CRkSEyojzUDdcHTYCeUg3yWdf4BtNqtaLvH2VQOMODtwJ2hZmZmXAwuF6vR1tbm8jce6/pKR9rAnTVCW4nU9/p+64hiV1l3XuBqWt0V9n8ds+6W5TS7RK+dv0dL1Pf7zt0/X1P9bpdXUyfc7c2uJc+7Uk+72pO7k3+VNM6P8rJ76HkBu1poDA8PXiQWbx/lQRgYHhsxTbWBAyMAAyPRGG8113e+00h8iiDzh978eyXEoF4JedJs+509W58muX6J6F/f7EV4FHne/mlwHs4/rsK4ahRo/Db3/5WONyiNzN0dHQ0FixYcE/PMTMzw+9//3sMGzas18952vr3we6s/byTFxgYSK+88grZ2Njc1m/HNJCk6+d32u3t6Z6eyjINUrlTub2pD/95//79acCAAbct/25nEvA+NnFxcRQXFyeUc7v68eWp1Wq6ceMGffLJJ6L3vd3v+P+PHDmS2traKCYmRnh+b96/px1i08/69etHwcHB3QJdeqpP17J6+n9v2u8Xun6ZSLAPP/yQioqKBAJ0dSq7XcPejVw9dcrtSIhebK3frj493WtlZUXXrl2j1atX3zXyDXeIktJoNFRQUCCUw7s13Kl+AwcOpOrqasHJTS6X9+ogktWrV1N+fr7oUI6uxL2fPo6NjaV//OMf99yHj9v1QN2hTfNMPvPMM7h69Srq6upELq+8w1dwcDAsLS2RnZ0tHDWkUCgwaNAgWFpaorq6Gjdv3hRlFOZtx+7u7vDy8kJlZSUyMjJgZmYGe3t7lJaWCo5W9vb2UCgUKC0thaWlJXx9fWFhYYHS0lJkZ2eL6mtmZobg4GBwHIf09HQ0NzcDACwtLeHp6QkbGxvk5eXBzc0NPj4+qKyshKurK3Q6Haqrq2FjY4OAgABIpVIUFRWhsLBQtNHGb/Y5OjrCxcUFQ4cOhUajQVJSEoCfXJa9vLzg7u6OsrIyoX6mIgsfLJ6WlibsqMpkMvj7+8PGxgY1NTXIy8sT2ot//tChQ1FZWYnAwEB0dHQgPT0der1eVC97e3v4+PgAAAoLC1FWVgYLCwuYm5ujoqJCCIZ3cnJCZWUl7O3tMWTIECQnJwsJccvKygAAvr6+cHV1RXFxMXJzcwEAtra2kEqlQtY4tVoNW1tbIZueg4MDPDw8oFKpUFBQgOLi4l+nCMTPJi4uLlReXi7McKbLpK+vL8XGxlJ+fj4VFRVRRkYGBQUFkb29PR09epRu3bpF169fp7S0NAoODhb9Xq1W03vvvUf5+fmUnZ1NVVVVtHTpUurXrx+lp6fT8uXLhSN60tLSaP78+eTq6kqXLl2imzdv0vXr16mqqorWrl0r1HXChAl09epVysnJocrKSvruu+/I0tKS3N3d6cKFC5Sbm0slJSX0ySef0H/+538SEdGNGzcoJyeH5s2bRxEREXT9+nXKyMigvLw8OnjwIJmZmYnaQ6PR0B//+EfKysqitLQ0amhooJycHLK3tyczMzP661//Srdu3aKcnByqqKigpUuXisQJ/HxkUnJyMimVSgJAU6ZMoYSEBMrOzqaCggKqqqqiiRMnimZ/a2trSk9Pp4aGBrp27RrV19fTrl27BIc6a2treu+99ygrK4syMjKorq6Ojhw5QhKJhLZu3UqHDh0SVppx48bRjRs3yNvbm8aMGUMGg4Hy8vLo5s2btG7dOjI3N6edO3fSrVu36ObNm1RaWkrPP/88AaCvv/6a/va3vwnjZOnSpXT16lUyNzen0aNHU1ZWFmVmZlJ5eTlt3LjxocYE/yIEiIqKoubmZnr22WdFS7y9vT1du3aNLl26RKGhoeTv708VFRW0ceNGWrVqFVVWVlJISAi5uLjQ0KFDuw2kLVu2UENDAy1YsIAcHR1pz549lJ2dTRKJhD777DO6efMmubm50alTp+jEiRMklUpp8eLF1NLSQmPHjiVnZ2fasWMHabVa8vT0pJCQEKqrq6PPP/+cvL29KSoqijo6Omj8+PE0c+ZMam9vpylTppCfnx95eHjQV199RRcvXqTw8HAaMWIE2dnZUUJCAh0/fpxcXFzIz8+PBg0aJIgDPGn3799P5eXltHDhQvLy8qIzZ87QsWPHCAD9/e9/p9raWnruuefIycmJvv76a0pNTRWJOAqFgpKSkuif//wnAaD58+eTVqulzz77jEJCQmjlypXU1NQkTBh8e4eGhlJdXR0tX76c3Nzc6LXXXhPO/VIoFBQbG0ulpaX00ksvkZ+fH6WmptKePXuI4zhKT0+nHTt2CHV45513qKioiBQKBb311lt069YtGj16NI0cOZLc3Nxo165dVFFRQdHR0dS3b186ffo0nT17lpydnamyspJef/11oax9+/ZRYmKiEGdQUFBAgwYNooEDB1K/fv0etlfogz8Ab/PmzVRQUED29vaiz9944w0qLS0VXIafffZZamhooJde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', 'base64');
const PWA_PNG_512 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAC+F0lEQVR42uz9d3eb15nvD3/ReweIRgIsYC+iulVtuchlkjiZdXLm7TyvZ846mWQmcRwXuUiW1SlSFDtIggVEIRrR+/OHz96/GxALqEKJ0vVZC0uFIHC3vfd3X1UEoA6CIAiCIN4pxHQJCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiAIEgAEQRAEQZAAIAiCIAiCBABBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiAIEgAEQRAEQZAAIAiCIAgSAARBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiAIEgAEQRAEQQKAIAiCIAgSAARBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiBIABAEQRAEQQKAIAiCIAgSAARBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBAkAugQEQRAEQQKAIAiCIAgSAARBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiBIABAEQRAEQQKAIAiCIAgSAARBEARBkAAgCIIgCIIEAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBAkAgiCIXRCJRHQRCOItREqXgCCIvRZ9kUgEkUiEer3OXwRBkAAgCOIthhZ8giABQBDEO4JYLG7Y8RME8fYiAkCjnCAIbvZnC79er4fH44HFYkE8Hsf6+jqSySR/LwkEgiALAEEQbwH1ep37/O12O86ePYsvv/wSPT09uHnzJv7zP/8TqVQK9XodYrEY1WqVLhpBkAAgCOK47vrFYjFqtRrq9ToUCgW6urpw+fJlfPzxx7h27RrkcjkWFhagUCiesRYQBEECgCCIY7j41+t1vpM3Go0YGxvD+++/j2vXrmF0dBRWqxWxWAzZbBblcpkuGkGQACAI4rgv/kwAiEQitLW14cKFC/jiiy9w6dIldHV1QalUAgDK5TJKpRJqtRr/ffL/EwQJAIIgjuHCLxKJUK1WIZFI0N3djUuXLuHTTz/FuXPn4Ha7oVAoeCZArVZDtVptEAAEQZAAIAjimAkAtpArFAr4fD5u8j9x4gQsFgsqlQoP9JPL5VwwEARBAoAgiGO6+DPkcjkGBwfx4Ycf4uLFi+js7ES9Xkc2m4VCoYBKpYJEIgFA5n6CIAFAEMSxhqXuyeVyDA0N4YMPPsDJkyeh0+mQy+W4uV+j0UAikXABQBAECQCCII4x1WoVUqkU3d3deP/99zEyMgKJRIJEIoFcLgej0QiRSASJRAKFQgGpVAqFQgGxWMxfBEGQACAI4hjt/Jnf3+v14tKlSxgeHoZYLMb29jb0ej1kMhlyuRzEYjEkEgnkcjkkEgk0Gg2kUin/N4NiAgiCBABBEG8ozYu0xWLB+fPnMT4+jnw+j2KxCJlMhlKphHw+j3q9zoUAW+y1Wi0AQCaTQSql6YIgSAAQBHFsRADz64+Pj2N0dBQymQxLS0tQKpVob29HuVxGJpMBAG7yBwCJRIJCoYBSqcQrBhIEQQKAIIg3GKHZHwA6Oztx4cIFqNVqBAIBVCoVyGQyVCoVFItFiMViKBQKFItFvtjn83lks1kUCgWeGkgQxFs0T9AlIIi3c+cP/JbCZ7PZMDo6io6ODkSjUQQCARiNRiiVSsRiMdRqNYhEIuTzeeTzeZTLZVQqFeRyOeRyOZRKJWr8QxAkAAiCOG6WgKGhIfT392NnZwebm5uo1+swGAyoVquIxWIAAKlUikKhwBf8crmMbDaLbDZLiz9BkAAgCOI47PyF1f6sViuGhoZgNBqxtLSEXC4Hq9WKfD6PdDoNALzUb7VaRbFY5H5/ZgFg5n9yARAECQCCIN5whK193W438vk8VlZWoFAo4HK5EI1GkclkoNFoUCgUkM/nIRKJUCqVUCgUUC6XeRMg5gIgAUAQJAAIgjgGGAwG+Hw+yOVyRCIRFAoFGAwGqNVqbG9vo1wuQ6fTIZPJ8NS/crncIACKxSKKxSK5AQiCBABBEG8qwsA/4Le8f7b7j0aj0Gq1UKvVPNhPLBZDJpOhUCigUCjwDoHFYhGVSoVbA0qlEgBQHQCCIAFAEMSbjlQqhdVqhclkQjKZRCqVgtPphFQqRTQa5Z3+arUaf7GWv7Vaje/+s9ksFwsKhYIqABLE2zRP0CUgiLfHAsCC/zQaDcxmM5RKJVKpFIrFImw2G2q1GmKxGNRqdUP5XwAoFAo82I/l/hcKBUgkEohEIt4aWGhlIAiCLAAEQbwBAoCh0Wig0+lQr9d5pz+dTodSqYR0Og2dTgexWIxUKgWJRAKxWIxCocAX93w+j0qlwgsF1et1/j6CIEgAEATxhqJSqSCXy1Eul1Gv13kzn2KxiHK5DK1Wi1qthp2dHchkMkgkEuTzeQC/pQXm83luTSiXyw1VBQmCIAFAEMQbilwuh1QqRbVahUwmg0qlAgC+m1epVHyhZ/X/mQuA/T+LCWACgPz/BPF2QTEABPGWIPTLM799rVaDUqnkEf6VSgUSiQQymQy1Wg2lUol3BGQuAAA8958FBdbrdRIABEECgCCI4yII6vU6FwCsop9MJgMA/m/WOKhYLAL4rXwwswQw0UAWAIIgAUAQxBuKcIFmizfwWzwAEwAs/Y+V/mVBfZVKBeVyuaGUcL1e5/UASAAQBAkAgiCOAcIFnfn/2SIulUpRqVQAADKZjC/07Of1ep37/YVCggQAQZAAIAjiDYc19RGLxVCr1Xxxl0gkAMDT+lgxIKE1gJn9mZWAiQWpVEppgARBAoAgiDcNYRBgJpNBOp1GrVaDVqvlu3qFQtFgCZDJZLzRj1QqRb1e5/8WVgRk72UCQmgRoKJABEECgCCI1ywAmAk/nU4jHo+jVCpBpVJBIpEgk8lAqVRyk75YLIZEIuELOAsGZDn/TDRUKhW++2cWAFr0CeL4Q/Y8gngLKZVKiMViSKVSkEqlMBgM0Gg0UCqVkMvl/H1sRy8SiSAWixui/lkWAS32BEEWAIIgjoEFgJFIJBAKhVAoFGCxWCAWi5HP55FOp3m0P9v1s+wAtuunwD+CIAFAEMQxQ+gGWF1dxfb2Nnp6eqDValEoFFAulyGRSFAqlVAul7klgGUEsMWfiQqyAhDE2wm5AAjiLaVUKiEQCGB5eRmFQgF2ux1ut/sZdwCLBWDxAMJsAZYJQNYAgiABQBDEGwzbrbMFPBqNYm5uDqurq5BIJHC5XHC5XNDpdNBoNNBoNA0BfswtwEoFs3gA4eeTGCAIEgAEQbzhVKtV+P1+TE5OIhKJwGQyoaurC2azGVqtFnq9nlsBpNLfPILMIgDgmcWfXAEE8fZAMQAE8ZZaAthiHovF8OjRI4yOjsLpdMLlcvFKgVKpFPF4HFKpFLVaDRKJpKEKYPNn0c6fIN4eJAD+f3QZCOLtEwDCuv65XA5isRgulwterxdqtRoAeK3/crmMer0OuVyOcrnMqwiyKoEajQbJZBJLS0soFoskBAiCLAAEQRwHIZBOp/Ho0SN0dnbC7XZjYGAAHo+HF/phAkBY7EfYFRD4LVOASgETBAkAgiCOweLPFvJarYZgMIibN2/C6XTCZDLB6XSivb0dMpkM5XKZiwCZTAaZTAa5XM77AADgFgWCIN4OyAVAEG85rC5ArVZDMplEoVCA2WyGw+GA2WyGSqVCPp9HLpeDVCrl1QBZYaBKpcJdAPPz88jn8yQECIIEAEEQxwWxWIxSqYRUKoVKpQKdToeOjg5YrVbU63Xk83mIxWIeA8CaA5VKJajVahIABPGWQS4AgnjLYa4AFg+QSCRw8+ZNKBQKaDQaXLlyBXa7HYVCAbFYDIVCATs7OwDQ0CaYIAgSAARBHFMhwOIBQqEQfvjhB0ilUigUCpw9e5ZnB6TTaWSzWRSLRZ4ZwNwIBEG8PZALgCDeIZjpXiQSYWdnB/F4HNVqFSaTCS6XC3q9HrVajQcFskqAcrkc0WgUi4uL5AIgCLIAEARx3GApfSzFb2NjA19//TW3EIyPj/NCQawzINv5C6sCEgRBAoAgiGOI0B0QCATw1VdfoVwuo1Qq4dy5c/B6vSiVSsjlcqjX6ygUCrxPAPt9giBIABAEcQwFAFvQmQj417/+xTv/nT17Fm63G7lcjlcDlEgkvF8AQRAkAAiCOKYwkz4L8FtfX8fXX3/NuwCOjo6ivb0dlUoFlUoFEomEfP8EQQKAIIi3CSYCtra28O233/JAwHPnzqGvrw+lUonHBIhEIkgkEtRqNXIFEMQxhrIACILg7gCWHRCLxSCRSOD1etHV1QWRSISlpSXMzs5iZ2cHtVqNrAEEQQKAIIi3ARYYWK/Xkc1mUSgUYDQa0dPTA6vVilKphHA4jHA4jGKxSBeMIEgAEATxtiCM8k+n01AoFNwK4HQ6oVAokE6nEYvFkM/nf5tEJBJyBRAECQCCIN4GRCIRyuUyZDIZnE4nvF4v7xug0WiQz+cRiUSQz+dp8ScIEgAEQbwtVgC2qCuVSrjdblgsFqjVamg0GnR0dMBkMiGdTiMajSKXy/EYAhIDBEECgCCIY7z7Z/EAOp0OXq8XKpUKhUIBYrEYbrcb7e3tUKlUyOVyiMViyGQyqNfrkEgk/DMIgiABQBDEMRQA9XoddrsdQ0NDEIvF2N7eRqlUgsFggNPpRFtbG9RqNXK5HKLRKLLZLC8wRBDEmw/VASAIgsOCAFmFQIvFArPZzFMDS6USrFYrDAYDDAYDPvjgA/7emzdvIhKJNIgIgiDIAkAQxBu+6xeLxZBIJKhWq6jX62hra8Ply5fh8/ng9/uxtLQElUoFlUrFywLbbDbY7XYoFAqkUqmGwECKCSAIEgAEQRwDAVCv13l5YIPBgKtXr+LcuXMol8u4desWtra24PF4oNFokMvlUCqVoFar4XA4YLVaIZFIsLOzg0gkgmKxSIs/QZAAIAjiTVzw2a6/ucOf2WzGpUuX8NFHH0GtVuPu3bv45ZdfIJfLMT4+DplMhq2tLWSzWeh0OlitVqjValgsFiiVSsTjcUSjUZRKJcoOIAgSAARBvAmLPiv3ywL1WLBfvV6HSqWCz+fD+++/j8uXL0Oj0eDhw4f48ccfsbW1hb6+Ply4cAHZbBYLCwsolUrQ6XRQqVSo1Wqw2WxwOByo1WqIRqOIRqOoVCr8uyg4kCBIABAE8ZoQLvjAb8F+UqkUVqsVY2NjeP/993H69GmIRCLcv38f33zzDQKBAAwGA95//3309fVhfn4eT58+hVqthtlsBgBkMhlotVq4XC4YjUaUy2VEo1HEYjFUq1VuZSAI4s2BsgAI4i3a4e/2J1v4mX+fIZfL4XA40N3djaGhIfh8Pmi1WgSDQTx48ACPHz/GxsYGZDIZLl68iLGxMWQyGczNzSEcDsPn8yGdTsPv90OpVEIul8NoNKKzsxOfffYZ8vk8crkclpaW+HeyjAGCIEgAEATRwqLe6nt2W+iFaLVaGAwG2Gw2uN1ueDwedHR0wGAwoFAoYGJiAg8ePMDk5CRKpRL0ej3Onj2Ljz/+GDqdDr/88gtmZ2d5kSAACAaDAACFQgGTyYS2tjb09/fj888/RyQSQTqdRigU4gKAIAgSAARBPCfCoLq9AuyYz18mk0Gj0cBqtcLpdKKjo4PX9VcoFMhms3j69Cmmp6cxMzOD7e1tiMVi2Gw2nDlzBlevXoXVasXU1BR++eUXRKNRjIyMwOl0olqtYmNjAyKRCDqdDn6/H7lcDp2dnRgeHsbnn3+OWCyG77//Hul0uqFQEAUGEgQJAII4drvyZjN7K4tZ8079MEFx7POF/vu9kMvl0Ol0MBgMaGtrg8Ph4Kl6Op0Ocrkc5XIZ29vb2NjYgN/vx9raGkKhEMrlMqRSKQYHB3H27FmMjY1BpVLh8ePHuHHjBlZWViCXy9Hd3Q2Xy4WlpSX4/X7eGyAYDGJnZwcikQh9fX04e/Ystra2EAqF8PjxYxSLRSoSRBAkAAji+O6+X+cCJhKJeCEepVIJpVIJtVoNnU4HvV4Pk8kEo9EIg8EAo9EIrVYLuVyOSqXCi/UEAgFsbm5ibW0NOzs7AH5zD/T39/NXe3s7isUiHjx4gNu3b+Pp06cAgJMnT/J0wOXlZQQCAWi1WojFYsTjcWxtbaFer8NkMnEXQjAYRDQahd/v5+KHhABBkAAgCGIXKwGL0GcvhUIBhUIBlUoFpVIJjUYDo9EIk8nEF1u9Xg+1Wg2pVIpKpYJsNovt7W2Ew2Fsbm4iGAwiEokgHo/zan0mkwkOhwO9vb0YGhqCx+OBWCzG2toaHj16hMnJSYTDYYhEIng8Hly+fBnt7e1YWVnBkydPsLOzA7VaDYVCgUQigVAoBLFYDI/HA5PJBJvNhg8++AB+vx+xWAzJZJIqBRIECQCCOH4LtFQqhUwm4wFttVqNv/Z6v9BlwHbvUqmU/539KZPJIJPJoFAoePtd4Z+sFK9SqYRCoeCfXalUkM/nkU6nsbm5iUQigXg8zhf7RCKBVCrFF1ytVguHw4GOjg709PTA4/HAbDajXq8jFAphcXERMzMzWF5eRjqdBgAMDw/jgw8+wIkTJ7C9vY1bt25hfX0dOp0ObW1tkMlk2NjYQDAYhF6vx+bmJsLhMPr6+tDX14eLFy9ieXkZk5OTKJfLDYKHhABBkAAgiDcamUwGl8sFr9fLc+ArlQqq1SqvoS/cxUskEshksoY2uWyhbxYBwpdcLodCoYBEIuHBfGyhrFQqqFQqyOVySKfT2NnZQTwe569kMolUKoV8Po9arQaxWAyVSgW73Q6LxQKXy4X29nbY7XaYzWZeyCcSifCFf2FhAfl8HgBgs9kwODiICxcuoLe3F4lEAj///DMeP36MUqmE9vZ2dHV1QSQSIRgMIhaLoVAoIJFIYGdnB2KxGCdOnMDw8DDGx8exsbGBcDhMDxNBkAAgiDd/1892qFKpFE6nEydPnkRXVxfEYjHK5TJqtVpDbADzcTeX290tR5/9rtCaUKlUUCqVkMlk+Ist9js7O/z/dnZ2kM/nUSqVuAVCJpNBpVLB4XDAYrHAarXCarVyAWA0GqFUKlGr1ZBMJrG8vMxfm5ubKBQKqNfrUKvV8Hq9OHnyJE6ePAmLxYKNjQ3cvHkTd+7cQTqdhtlsxtDQEOx2O2ZnZ7GysoJqtQqRSIR8Po/NzU1UKhVYLBbo9XoMDw9jZmaGC5Tma0EQBAkAgnhjEJqnK5UK4vE4lpaW+O6WmbPZLl8oHKrVKiqVCl/kmbm+WCxyy0G5XOa7+nK5jFKphGKxyBd2JjDY+2u1GrckyOVy2O12aLVa6HQ66HS6hgBAvV4PlUoFmUzGF+VIJIJwOIxQKMQj9CORCKrVKgDAZDLB5/Ohv78fvb29aGtrQ7FYxMOHD/Hw4UPMzMwgnU5DLpfj3LlzOHPmDAqFAmZmZrC5uQmn0wmNRoNKpYKtrS2k02l4vV44nU5YrVb09/fzIMTdRBZBECQACOKNo1wuY319Hdvb29xfr9FooNFoIJVKn4kFYAs7cw/U63VUq1WUSiVUKpUGkSG0IggtDsz3LwwCFEb963Q6aLVa/nMWF1Cr1VAsFrlbYHt7G5FIBFtbW3xhZouvwWCA2WyGx+NBZ2cnOjs7YbVaIRaLEQwGMTk5iYcPH/JF22KxYGxsDFevXoVGo8H9+/cxNTWFXC4Hk8kEs9mMSqWCcDiMbDaLWCzGz7ezsxNutxuRSISLJ4IgSAAQxBtvDcjlctx8rdVqYbFY0N7eDrlcznfszewW7MaK9MjlckgkkoZ/sxgA9hK+h/3JPq9araJYLCKXyyEejyOdTiOVSiGZTCIej/PI+0wmg0qlgnq9DplMBqPRCIvFwosDeb1e2O12KJVK5PN5rK2tYX5+HrOzs9jc3EQ2mwUAWK1WXLx4EVeuXIHBYMDk5CRu3bqFUCgEg8GArq4uaLVabGxsYGtrC06nE8ViEZubm1CpVDAajTyLIBqNUkYAQZAAIIjjJQSA34rutLW1obe3Fzqdjpvq2aIv9PkL4wCEL+FnCt/PrALVahXpdJq7B8rlMl/ws9ksstksjxHIZrNcoDDXgkgkgkwmg9lshslk4os+CwJk1oNarYadnR3Mz89jZWUFq6urWF9fRy6XA/Cba6Cvrw+nT5/GwMAApFIpJiYm8NNPP8Hv96NWq6GjowPDw8MQi8VYXFxELBaDy+VCrVZDLBaDTCZDW1sbrFYrLBYLotFog0AiCIIEAEG8sbDFigX3ZbNZRKNRFItFSCSShqA+ZorfzRLAIvpLpRL37bN/s0W+WCyiUCigVCpxtwETAuwlzD5gWQcmkwlqtZrHArCF32AwQKvV8loB5XIZqVQKa2tr/LW+vo54PA4AfMH2eDzo7e1Fb28v3G43MpkM7t69i19//RXLy8sAAI/HgzNnzsDpdGJhYQFPnz5FNpuFWq2GWCxGLpdDoVCATCaDTqeD1Wol3z9BkAAgiOO3+69Wq0gkEpicnMT8/DzkcjnP0WcLv9CfzxZ84YLHdvhs8Wb/ZqJB2LaXFQaSSCTQaDQwmUzcVaDRaHggoFarbagfwNIJWUxAJpPB5uYmotEoDwiMRqNIpVLcfaFUKmG32+HxeNDT0wOfzwer1YpisYjZ2VlMTExgdnYW29vbAIC2tjZcunQJJ0+eRDKZxKNHj7C2tgaFQgGz2QyxWIydnR3EYjFotVpevEgsFvPgQ4IgSAAQxLGhUqnwlDwA6OjoQHd3NwwGA4DfggaZ+Z9F/O+24LH8f+YLZ75+9v8s4FBYP4DFBgh/l+2omSUhHo8jm80ilUrxgkCJRAKxWAypVAqFQoFbJvR6PWw2G1/429vbYbVaoVarUSqVsLKygqWlJczMzGBxcZG7OgYGBnDu3DmcPXsW9Xod9+/f58V+3G43HA4HJBIJ4vE4QqEQXC4X7HY7t0KQACAIEgAEcSxhvn2pVMpb4brdbojFYhSLxWdq37PdfXOMgPDf7DOFNQSYRUFYeZDFB+Tz+WdiAnZ2dpBKpXhsQKFQ4Iu2XC6HWq3mtQHYwm+z2WAymXht/1wuh6WlJSwuLmJ2dhZra2uoVquQSqWwWq3w+Xw4e/YsBgYGUCqVeN+AaDQKjUaDkZERuN1upNNpbGxsYGdnB7VajVsyyPdPECQACOLYwsz8LNBtfn4eiUSC+9ib8/bZwscWP7aQs/eyzxRaDMrlckMsQKlUQqFQ4DECuVyuIZZAKE5YWWGHwwGDwcDjAVi9AJ1OB5VKxfsHZDIZLC8vY2NjA+vr69ja2kI8HufBgAqFAv39/Th58iRGRkZgMBgQDodx//59PHr0CFtbWwCA9vZ2nDp1ChqNBhMTE1hfX+cuCVYPgfz/BEECgCCOPaycbjab5bX62Z+sSBAz8QtrADABICwYxAQF+z+h2Gi2HrAYABYPwOIQWMMgFheg1Wr58chkMgDgPQRYCd9wOIxIJMJjA4rFIoDfihyxGgHd3d3o6uqC1WpFpVLBzMwMHj58iKdPn/Lgwe7ubly7dg2dnZ1YXV3Fw4cPkUql0NbWBp1Oh2q1ilwuR+Z/giABQBDH2wLAFvJcLsd3ymq1Gl1dXWhra4NarUa5XG6I4Bcu5sIUwOZ+Aqw+gFKp5DEAbLFn/69Wq6FUKnlMAKsVIJVK+bGx1EEW8JdMJhtqBcTjcezs7PAYBKVSCYfDAbvdDrfbzQsEGQwGXhDpyZMnmJqawvr6OoDfggc7Ojpw7do1jI+PIxKJ4Pbt21hcXIRIJILT6YTFYkEul0MsFtu1gRJBECQACOJYo9Pp0N3djVOnTvHKeMJFX0hzj4DdfOPC4j/NpYGZmyCZTCKXy/EUQrboszoBmUyGxwkwFwJzUchkMlitVhiNRtjtdrS3t/OmQazGQSqVwpMnT3hcQDgc5gGQGo0G4+PjuHLlCvr6+hCNRnHjxg3cu3cP5XIZRqMRXq8XRqMRgUAAwWCQBABBkAAgiLcDYTAfcwksLCxAp9Pxojwsal/o/26uF9DsG2f5/8wlwKL8Wc0AFhPQHA8grCvA0g1ZtUGLxcJrBZjNZpjNZi4A1Go1FAoFD2RcW1vDxsYGlpaW+N8ZFosF3d3dGBgYwNDQEGw2GzY3N3Hr1i08ePAAOzs7kMlkGBkZwcDAACqVCgKBAC8CtNv5EgRBAoAgjhXCvH9WgndycpKb7fV6PS+MI+wb0BzdL/wcAA1BgiytkP3ObhkEUqmUuwTYS6VSNdQKYPUCWGEguVwOkUiEUqmEdDqN9fV1BINB/idr8wv8Zuo3Go1wu93o6elBX18fPB4PqtUqpqamcPv2bUxPT6NQKEAqlaK3txeXL1+GxWLB9PQ0lpaWuKuEigERBAkAgnirYIt5uVyGWCyGxWLBwMAAHA4HX9SFTYJYcCAz6wsXRfZzoQWBLfqs+p+wZoBw4ZfL5Q01BIS1ApiLIBwO8/oA29vbvGZAJpNpqBVgNpvhcrnQ0dGBzs5OtLe3w2g0olKpYGlpCbOzs5iZmcHGxgYPIBwaGsKHH36Ivr4+BAIB/PrrrzxmgCwABEECgCDeOoR+fJVKBbPZjPb2dnR0dHCTv7CMb3NNgL0+T/iz5t8TLqhMYBQKBaTT6QYXAYsFSKfTSKfT2NnZ4fUChNUAdTodLwjU1tbGW/oajUbIZDKUSiUEAgEsLy/zAkHs9+12OwYGBnDhwgV0d3cjGAzi1q1bmJubQ7FYpJ0/QZAAIIi3F2HZ4FQqhdXVVaTTaV7lj9UEEO7uZTIZD/jbzarAYgGEn80yDFisAKsPIPxTGPhXKpUa3AkymQwKhQJut5v3D7BarbyBkNFohEqlgkQiQalUws7ODjY2NrC8vAy/349QKMQtHVqtFi6XCydOnMCpU6fQ1taGtbU1/Pjjj5iYmOBdBWn3TxCveZMCgEYfQbxixGIx5HI5lEolX+SZLx5AQ+c+Zh3YLUJe2CGQ/Vu42xf2HWDpfM2uAdZimPUKYDEAzfEATISwnP1UKoVIJIJgMMjrBSSTSV7TQKvVoru7G0NDQ+jv70dbWxtKpRIWFhZw//59zM3N8YwBgiBIABDEO4lCocDw8DB6enp4Bb5SqcR3+c0FgPiA3cc1sFcPAbbos6DA5h4CwloBLC4gm80imUwilUohkUjwuIBYLIZ0Os2/22Qy8W6BbrcbbrcbVqsVMpkM4XAYT58+xcTEBC8hLDxWgiBeL+QCIIijUNpNfnubzYb+/n6Mj49Do9HwBbi5XfBei/5+/9/cP0BYK0DYapjVDGCvbDbLYwFYzYB8Po9isYhKpcLLCtvtdhiNRjgcDh4Q6HQ6odVqUSgUEAwGsbCwgLm5OQQCAb7rp8WfIMgCQBDvtAhgnfc8Hg8cDgdUKhVfsJlPnnX2a14wD1o8hS6C3WID2N9ZHAB7MYsDcyMIqw+ycsImkwl2ux1tbW0wmUy8m1+pVEIymUQkEsHm5ibW1tYQCoUa3AMkAAiCBABBEP9vMWT9ASQSCYxGIywWC1QqVUN0vNDfz+ICWKrgXgKgUqns2miHBRqywEPmLmBuApVKxV+sXoBGo4FarW4oNSwWi3mtgFgshlAohLW1NQSDQWxvb3NXBrNGNHdBJAjizYBcAATxGmgu/GMwGNDf3w+HwwGRSIRCocCD+4SFgViswG4LvLC7oHAXzzoQChd8VhNAGCPQXDOAfRbLJIjH44jH4wiHwwiFQohGo0gkErxL4W7HI6xxQBAECQCCIPD/mcKlUilUKhVMJhMcDgfPr2cL9m6LqvD3mwXAbn/fzfwuFCCsDbCwfwDrGZDNZpHJZHj9AFZDQLjTF8KqFDafJ0EQJAAIghAszmKxGKlUCktLS0gmk1AoFKjVanyHzkQAq+Mv/L/9PpfVDGA5/0L3AIsJYDEAhUIB+XyeBwSyBb9QKOxpumfH3ixqaMdPEMdk/gHFABDEa0cY+McWd/Zv4Yul7e1VKKh5MWaR/8KeA+z/mxfr3f59kMigXT5BkAAgCOIttVDslm64W4AhQRDHC3IBEMQbtNDuldv/Iottq3UE9vLbk0mfIMgCQBDEaxAGLxNayAmCYIjpEhAEQRAEWQAIgiAIgiALAEEQBEEQJAAIgiAIgiABQBAEQRAECQCCIAiCIEgAEARBEARBAoAgCIIgCBIABEEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiAIEgAEQRAEQQBSugTE24JIJHqpn1ev1+miEsQLjkfhuGx1jArHHvs7jcdXcI8A0FV9TQvP63qgj9vxtnrs7Gcv4zhFItGen3OU1+F57tVR36ejfp6O6/N7nMfd85yjcAy9yDnsdd1IELw45AJ4i3as79L1EolE/CWcEF7WpMA+Z7fveVPv2+s4rqP+zndxzByXc27e8QvH4vOcQ/O428+yQJAFgHiHJsLXof73Eh21Wu2Nu060OyJex5io1Wq7PntyuRxyuRwymQwymYz/WyKRoF6vo1KpoFwu81elUkGpVEKxWNzze8Vi8Rs9DkkAvANIpVJIpdKGh7EVarUaqtUqKpXKkZuUZTIZJBLJofxxtVoN5XL5jRlkIpEIEokEEomEX382uchkMkilUshkMojFYv4+sVgMqVS6531gfxaLRRSLRZRKJZRKJf6z/c79ZbofhOd3mGeLTZxC68WrfLae5xiF151d11aPUSQS8fF22N2f8B6/zudVJpMd6thf93G3Isib759UKoVKpYJWq4XRaITJZILRaIROp4NarYZKpYJarYZCoYBUKkW9Xke5XEahUECxWEQ+n0ehUEAmk0EqlUIqlcLOzg52dnaQy+VQLBZpsX9Z6xddgudHIpHA4XCgs7MTBoMBEonkwAeTTZTpdBobGxvY2NhAPp9/ZZO18HOlUiksFgu8Xi+sVisffLVabc9Jif1+MpnE2toawuEwV+VHudOUSCSQy+V88tBqtdBqtdDpdNBoNNBoNNBqtdBoNFCr1VAqlQ2TjFwuh0Kh4KJAuGgWi0UUCgWUSiXkcjmk02mkUikkk0k+AcXjcaRSKWQyGWSzWT4h72amfFF/Z71eh0wmg8vlQkdHB8xm8547nHq9DolEgmq1ilgsho2NDWxtbfF7+irvj0KhgNvtRnt7O/R6PcRi8YELFXvPzs4O1tbWsLGxgWq1uu+xsp+pVCp0dXXB5XJBpVLt6/Kp1+t80a1UKohGowgEAohGo0e2eLDjFovFMBgM8Hg8cLvdkMvlBwof9kxlMhmsra0hGAwin8+/MRae3SxhMpkMZrMZbrcbXq8XXV1d6OzshMvlgtls5uNTuPsX/r5QgBcKBWSzWaRSKWxvb2N9fR1ra2tYX1/HxsYGotEodnZ2UCgUXokAJwFAtDSwfT4fvvzyS/T19UEul6NcLu+5mFarVSiVStTrdayuruLGjRtIpVJcALyMBWQ/AaBWqzE6Oop/+7d/w8DAQIPZbrdFjP2fRCLB6uoqvv/+e/z4448Ih8OvfCJqHtBarRb9/f0YHh6G1+uF2WyGRqOBXq+HVqtt2FUIzYxsdyrcqQrPle1E2S6rVCqhUCggl8shm81yMRCNRhEKhRAMBrG2toatrS1sb28jlUqhUqk8MzEe9roI/ZpssRsZGcGnn36KoaEh1Ot1FIvFZ3ba9XodUqkUlUoFwWAQt2/fxnfffYf19XW+0L2s+9T8jGo0Gpw8eRIff/wxurq6IJVKUSgU9vTd1mo1KBQKFItFLCws4F//+hdCoRCq1SrEYjE/XqEFQ3j8er0ely9fxtWrV2Gz2biA2836wJ5phUKBbDaLiYkJ/POf/0QikUCpVDqSBYMdt0QiweDgID777DOcOnUKKpUKpVKpYYw1j31m7YhGo/j+++/x/fffIxAI8N95nQsdu7/sfsnlctjtdvT29mJkZASDg4Po6emBw+GA2WyGXq/n4/Iw1g/mBsjlclwIhEIhrK6uYnl5mb9CoRBSqdQbaSUhAfAWLv5sAIpEIjgcDpw/fx7nzp3jFoC9JsBKpcJN0HNzc1hbW8Pt27ePxEzHjvXChQv43e9+B5/Pt+tiv5sIEYlE2NraQqVSwcrKymvZRRkMBpw7dw7/9m//hqGhIeh0OkgkEiiVSsjl8lf2/bVaDcViEZlMBvF4nE9AKysrWF5extLSEtbW1hCPx1EoFF7axCyXy9HR0YGLFy/i1KlTXEAKd03Ce1ev15FIJOB0OlGpVPD9999zS8CrtAB0dXXh8uXLGB4e5sfYLLKEApiNEbPZjOnpab54t7IwqNVqDA0N4dq1a3A6nXteE6EAEIlEyOfzEIvFePjwYcN7j2ohNRqN/Nk9efIkXzz3sx6xDUYmkwEAbG5uIhwOcyvA64RZXiQSCcxmM/r6+nDy5EmcPXsWo6Oj8Hg8MJvNu57bXjECu82xEokEarUaarUaVqsVPT09KJfLiMfjCAaDWFlZwezsLGZnZzE3N4dAIIBkMtkgyAkSAK9kQRWaNJl/WWji3/ViC/zPzC/9KhHuqjQaDQYHB3Hq1Cm4XK59z2m3/7PZbDhx4gRGR0exurqKSCSCWq3W8B2vYqIRi8Wo1+tQq9Xwer0YGBiAx+M5svstFouhUqmgUqlgsVjQ3d2NkydPIplMIhgMYm5uDk+ePMGTJ08wNzeHSCSCUqn0wtYcdu7Nz8x+As9sNuO9997jsRo//fQTgsHgK71Pzc/xfs80+xmL13ie55+Nt4O+TzgO2e8cVdQ4u9b1eh1yuRw+nw+nT59GZ2cnP4a95onmCHetVouRkRGcPHkSc3NzWF1dPXIBs9ucoFKp4PF4cP78ebz//vs4ffo0PB4PF+YHbZ4OM8cKkclksNvtsFqtGBgYwPnz5xEIBHDv3j18/fXXePDgAWKx2DPzH0EC4JXtEJkfWSaTPWO+3G0HxEyXR2WyEolEsFqtGBoaQl9fHxQKxTNm64PUvlQqRVdXF0ZGRvDo0SPE4/EjVdpisZhHEQstKkwgHDSR7Gbl2OtnzZ/HIo7ZSyaTQa/Xw+Vyobu7G6Ojo3jy5Al+/fVX3Lt3D0tLS8hkMvz3nncSYi4J9pzstdtlxy8Wi2E2m3HhwgVks1kerxCPx1/Z4seOkZnimdjY673MAvA8AaUsWrxYLPJrstf3Ce8pC+g8SqsVOwaj0cjHnU6na/D973dP2LUSiURwu90YGRlBR0cHgsEgyuXykQsAodlfoVDA5/Ph2rVr+PTTT3Hy5EnY7faG8xa6n1pd3JvnnL2skUzQqVQquN1u2O12qFQqrKysYG5ujgsAShMkAXBkA4M9lCygaS8fKJvAj+rhZME57e3t8Pl8cDqdzwQrHiQA2HvNZjN6enrg9XqxuLjIzZNHdR5MaAnNpK8iR795UhVeA+HPJBIJ2traYLVa4Xa74XK5YDQaIZPJ8OTJk5fiEmCmUKFVYD8xKhaLYbVacf78eUQiEWxubiKTyXCrxKtYNITP/37HyMzGL3qfWrkmzMTORNvrWgwcDgcGBgbgdDohk8m4aG3lGjBBpdfr0dXVha6uLszOzmJ7e/u1WD3ZNXW5XLhy5Qp+97vf4cyZMzAajQ3mfXbdX/Qe7zUua7VaQ5ArcxWIRCKKAyABcLTsFrB0UAGLVy0Amj+bTSCdnZ3Q6/W7mkn3+yw2qBUKBdrb29HT04MHDx5wAXBUEbjNE8urmtj327XsZkkQi8Voa2vDqVOnoFAoIJfLUavVMDMzwwM8hUFTz3ssez1XzfdTLBbD7Xbj3LlzWF5eRjwex/Ly8iu7V8Lj2u8YX0YBl+b87/3GWitj8lU8O+zaqlQqeL1e+Hw+mEymQx2L8F6KRCI4nU709vbC4XA0CICjSPUUfofNZsPZs2fx4Ycf4sSJEzAYDA3HvJ+l7WWNy+bg0HK5jHA4jLW1NSQSiT2FPEEC4J0TJ2KxGE6nE2NjY/B6vS8cd8DMkb/++ivC4TB3AxyVOfJ1m/WaMwjYOTPz+/j4OM9GkMvlmJycRC6Xe2bSelXHJvQ99/f347PPPsPOzg6y2SxCoRDfMbUSjEU8vwAQiUSw2WwYHByEz+fj2T+tPsPNz4nZbMbIyAju37+PpaUlbl06CgHA5hKdToczZ87g97//Pc6fP8/TU5urZh7GuvYi4539LJlMYnFxEcvLy3ys0bNNAuCdnoTYblOn06Gvrw/j4+PPBP89zyRgs9kwOjqK4eFh+P1+nhJ42EIwbwPNlcgAwGAw4OTJk9BoNNzkOzk52RAYeBQCpV6vw2Kx4MKFC7y2wY0bN5BMJl96eiDx7LVXKpXw+Xw4ceIEOjo6eM2NwwpY9js6nQ7Dw8MYGRnB1NQUVldXX+luW3hO1WoVcrkcQ0ND+PTTT3Ht2jW43e4XLvX7IlYMoegIh8M8AFfoEqJnmwTAOzkJCQdje3s7xsbG0NPTA5VKtW+a4n4LHVP6YrEYXq8XJ0+exJMnTxCLxY7cCnBYmv33uwX57fbvw1wn4fukUin6+/tRqVSQy+WQyWQwPz/Pr+FR1k8wmUy4fPkyz6W+e/cuMpkMTZKv2DJltVoxPj6OwcFB7nYTxgAd5jNZbIfb7caJEyfw6NEjhEKhPcvkvkxLBns+7HY7rl27hg8++IBvJA6KSREu1rsVbdrNHbVfQO9uLtRSqYTl5WXMzs4imUy+kLWBBADxVkxEQh9kb28vTpw4wQunvAzFrtfrMTY2hsHBQczPzyORSLzR6TbPY51onrRaFQMsCFQikaCvrw+ffPIJ1tfXkUgkEAqF+PG86mAlYa65w+HA1atXsb29jXQ6jYmJCR61T1aAlzvuarUaZDIZvF4v3/2/6O6Y1VZQqVTo7+/H2NgYJicnsbW19cpdS7VaDSqVCgMDA7hw4QJ6enoaXE2t7tRfhoVQ+J3sfFOpFPx+P1ZWVl6pICIBQBybXQhbjB0OB0ZGRjAwMAC1Wv3SvoflNo+NjeHBgwdIpVIN6Vhv4oJyUFvS3QKMDludURigxqo+Dg0N4erVqwgEAojFYjyF66ieBXbcHR0duH79OpLJJNLpNBYWFvjCQgLg5QkuALBYLBgcHMTQ0BBMJtOu2SrPcy9FIhG36HV2dvJaHK9CAAg/z+l04tSpU+jv74dGoznU+TTHzLBKm6zPBkvPZOm1rGw3ewmrd7Kxxd5frVaxvr6OpaUlhEKhhoqm9EyTAHgnEUbs9/T0YGRkBG63m6cUPe9E1GyOtFqtGB4extDQEAKBAHZ2dnadPN6E65HL5ZBMJrGzs4NisdjQNIc1aFEoFFAoFLyHgEajgUKhaPgcdu6tBCYJTfAnTpzA9PQ05ubmeGGeoypFy76DWSQ+++wzpFIpZLNZrK2tNTwPNGm+2HUGfksN9Xq9DUG3wpTEF12MTSYTBgcHMTo6iuXl5Yay3K/ifMRiMTweD8bHx+FwOPZ8335zUbVaRSKRwObmJq/jn0wmkclkkM/nUalUIJFIoFAoeBMhnU4Hi8WCtrY22Gw2mM1m6HQ6fkxsXC8sLGBxcRGpVIr/jIr/kAB4pychVoBkZGQEPp8PGo3mpe+kJRIJuru7ceLECTx48KBBALxJQqharWJjYwP37t3DzMwMMpkMbz3KFkbWZIj1FjCZTGhra4PL5YLT6YTJZOJioNVFUriz9ng8GB4eRmdnJ6LR6L79Il7Fc8HEi1wux/DwMD777DOEQiFks1leNIXVsCBebIHWarXo6+vD8PBwQ8rti8CeJRZD4Ha7MTY2hkePHvHAt1dlMVOr1fB4POjs7IRarT7Ud4lEIhQKBSwvL+PBgwd4/PgxVldXEYvFkMlkkMvleEE0VvWSiXCNRgOz2Qyn04mOjg50d3fD6/XC6XTyPiA7OztYXFzE+vo6PbskAGgSEu40PB4PxsbG4PF4nsmbfpHvEP6+w+HgAYYbGxvcB/e6zcrCYLtKpYK1tTV88803+O6773gAXHPREplMxncfBoMBNpsNXV1dGBwcxMjICPr6+mCz2VrexQkbRplMJvh8Pvh8PszOzvJc5aOylAhdMwaDAadOnUIkEkEqlcKtW7eQzWbfiCYzx1l4M+uQy+XC8PAwfD7fK+tRIawuOD8/j3Q6/VLvn9Cdwbr7Wa1WXoVzv+8QHke1WoXf78ff//53fP3115iZmUEikWi5BbpcLodGo4HVaoXH40F3dze3OnZ1dWF5eRlzc3PPFEaiZ5gEwDttATCbzRgYGMDAwADMZnNLiz+rrsUqpx20sLH6/CwWYH5+HoFA4IVFxsumVqshl8shEonwILyDriPrJPjgwQM4nU6Mjo7i2rVruHLlCjweT8NEuF/RGzaJsloMnZ2dMBqNSCQSDX7Uo5qw2He2tbXhgw8+QDKZRDKZxOPHj3mnQZo8Dz/m2DXTaDTo7e3F0NAQHA5HQ02A/e4J273uN/aE38Xce2NjY5iYmOAZJi/DlSMU+azZj91u59aMgz6bWSlEIhG2t7dx584d/P3vf8fDhw8P3ciIxQgkEglsbGxgamoK9+7dQ39/P7q7u7Gzs4OnT582VCSl55cEwDtNvV5vqB0ulUr3rc/OBm02m0UymYRUKoXFYjlw98J2t21tbRgdHcWDBw8aWtC+aRO1VCqFTCbjE9RuUczMzMomnkwmg1AohPX1dYTDYVSrVXzyySc8srvVtK56vQ6tVguHwwGj0fhMitVRXgdWY769vR0ffPABotEo4vE4/H4/1Qd4QcxmM4aHh9Hd3c3Hz16dNtn/ZbNZ7OzsoFqtwmg0cj/3Xpac5iJDvb29CAQCDcWmXqblyGAwNLjADppLhM/NxsYGJiYmeEVM1itF+Hztl5IrLP2bz+eRz+cRjUYRCAR4t0FhGjJ7L0EC4J3d/atUKvh8PoyMjMBqtTYMpL1K2pbLZQSDQUxNTUGpVOLMmTMNOxjh7zYvDjqdDoODgxgYGMDU1BTi8fgbG43Ldlv7pTHtVuZ3e3sbt27dglar5QFJWq12z2vb/FkikQgqlYr/rlQq5TEIR7nrbt7d9fb24vr16zweIBgM8nMmn2pr15M96zKZDJ2dnThx4gRvVbzXMyUUoeFwGLOzsygWixgdHYVWq9113DVblVQqFQ/yffz4MdbW1p6x0r2M81OpVFCr1Q1NuFpZ/Gu1GqLRKDY3N/nOX2jtaPX4dpt3mOXqTbM2HkfEdAnenolILBbD4XBwH6Qwin2vwVqv11EsFuH3+/HDDz/g559/xsbGxr4dx4SLu1QqhdfrxcjICLxeL29f+6YNzMMeT3PN9mw2i8ePH+P+/fuIRCLPLKgHIZPJYDAYoNfrX5lv+DDXoVarQa1W48SJE/jss89w7ty5Z+q60+Ta2rVkVRcHBwfR398Pg8HQEGOynxgNBAK4efMmbty4gZWVlUMV1XK5XBgdHUVXVxcUCkVD7MvLGivsOXiern7lchmlUokH276o5Wu3Z/J1WNJIABBv5CQkl8vR09OD4eFhvoNnA2e/32fRtPfu3cODBw94Te2DBqOw/G1/fz8GBwd5nvCbhnCiEBb52evFYiLYLl0ikSAajWJhYYG3ZD3MRCuTyaDValveTR3F81Kr1WAwGPDee+/h+vXrGB4ehkKhoN3/c1xTr9eL0dFRuN3uA91CbEHNZrNYXV3F/fv3ce/ePfj9/gM7bAoDOnU6Hfr7+3msz2F6DRzFNdHr9dziVa1W9+2UetC4FY5fNh6ZqCBIALyzE49wADT3Hmc7vd1UM6NWq2Frawuzs7NYXl7G8vIy5ufnD4ysFe5QFAoFuru7MTY2xnOF36TJ6GUIh3q9jmw2i2g0ilgshmKxeKCbozk/XKVSQaVScSvJ60S4SLndbnzwwQf49NNPeaU3dl7vYo+Hw447jUaDgYEBjI6Owmg07vm+5jERCoWwuLiIhYUFHtG+sbGxr5m82frW0dHBaw68rGyf/cZ9q9dFJBLB7XZjcHCwoQfJi7QKFopzJiho908C4J2eiNigYJPB6OjogU1/moOQ2KKfSqWQSCQwOzuLtbU1ntbXijmyra0NQ0ND6Onp4XUHjqJZyVFSrVZRKBR48ZLDTFysPHDzruVVXp9WzKPs2Lq7u3H9+nVcunQJLperIaWUdll7XzuJRAKXy4WhoSF0dnbua90R3ot8Po9AIIClpSVEo1GkUinMz89jfn6+oaTtQffPYDBgeHgYAwMDDT0HXuTZEn5npVJBpVJ55jMPEr31eh0ulwsXLlzA5cuX4Xa7uVWNuSslEgnPfDiqds0ECYC3bhKq1+s8BYlNBAdNHGxRj0QiWFpaQiAQQK1WQ7FYxOLiIpaWlnh1rb0GprA0p1qtRnd3NwYHB2Gz2d4aC0DzQnmcFsWDJlX2s0qlAoVCgaGhIVy/fh1nz56FVqvluy1id2q1GhQKBXp7e9Hf39+QcnvQfUkkEvD7/VhdXeXlcFdWVniufCuLLRP+3d3dGBoagtPpfKkZHCz6nhXsafXchJaR0dFR/P73v8cXX3yBwcFBXkyI7eCZIGj1mSVeLpQFcMwtAOxPtgvp7u6GUqnk1bV2M0GyP4vFIlZXVzE3N4doNArgt9zbtbU1zM/PY2trC1ardc9I9eZSs263G8PDw3jw4AE2Njbe+C6Bh138mR9fo9EcyozP0u8qlcozZsuXfV2YiKtWq7yy2l5CrDlGRK/X47333uM1EyYmJngbY5qUGxcoYd3/5oqbu6XKNd/nYDDIS0Ozn7O2toFAADabjQeL7ubGExaaamtrw+DgIPr6+rCxsYF0Ov1Cz7rwWUokEohGo8jlcjyFtdU5iV2f999/H1arFd3d3fjll18wMzODUCjE44z2W/TJxE8CgNhHZQPghUEGBwef2YXsN2AzmQzm5uawuLjYEPSXTCYxNzeHpaWlhontIJM+K4Pa19eH6elpxGKxY72DFNZvr9frUKlUsFgssFqtPOr6oCIvwqj7fD6PQqHw0oPsmlM6w+Ewtra2oNVq0dvbC6VSyRel3Y5ZmEXidDpx+fJlbG5uYnt7G36//5lFh6xuv10DqVSK9vZ2DA4Owm63t3yPMpkMVldXsbCw0NDCNpvNYmVlBfPz8+jr6+NpvPtZ8Nj47+rqwtDQEB4/fvxCAqD5mLe3t7G1tYVUKtVycaPm4zSZTDy1uK+vD1NTU3j69CkWFhYQCoUQj8efcak1d6qkaH8SAMQeE5HJZMLAwMAz5Uf3q1JXr9cRjUYxPz//TAGfSqWC5eVlzMzM4Pz58w29BPYb/KwRytDQEO7cucPbBB91xbtWhVMr7xGawdkEZrfbeYGlVk2WlUoFmUwG6XT6lbYtZfnXv/zyC483GBgY2NdiIYwlEYvF6O7uxocffohAIIBkMskDQqlSYGMuvl6vh8/nQ29vL3Q63YELI/tZJBLB4uIib2ErLJ27ubmJ6elpnDt3bl8B0PyMOhwODA0Nob29Hevr68+0zX0eQVmv15FMJrG2tobNzU10dXVBqVQe6vPY+FEqlfD5fLDb7RgdHcXS0hKePn2K2dlZLC0tYWNjA4lEAplMBuVy+ZmNw5syh5AAIN4oASCTydDR0YGhoSF0dHTwHetuE5EwqpsF/y0uLj4zwdfrdWxubmJ2dhYbGxt8wRMWPmlW62wHabfbuRhZW1tDKpVq+N7XNYCFef37HYtwkRP+nNXQP3/+PN/tHSbOoVAoIB6PI5VKNQRXvmwrAGvA8vTpU2xubkIkEvH4jP2uvfCaaLVanDhxAtevX0c0GsWtW7d4pbl3vXOgsNscq/vv9Xp5+uRBbrdSqYT19XUsLCxga2uLV2ZkC+X29jZmZmawsrLCa3kIx9deYpVtAvr7+7G4uMhrVTyPaBNai1iNkCdPnmBoaAgul6vh81pxCQiPW6fTQavV8uyFUCjErR7z8/O8uU88HucFhIRjtzklkCAB8E7uQtgg0Ol0fMEV1us+aCcSj8e5v7FUKj1TcYuZI5eWltDb2wuLxbLnxC9U5qwi2vDwMCYnJ3kg4fPuRl4WLOiITXBsEm8+nt12Hna7HWfPnsXnn3+O8fFxqFSqlsygws8uFAqIRCKIx+P8OF6FX50tQJlMBlNTU7xIjdFo5Lni+5VzZVXqzGYzLly4gK2tLZ4myhY4sroBSqUSPT09Df02WhGE6XQafr8fy8vLyGaz/J6xHPlCoYDV1VXMz89jfHwc7e3t+wouoeWGxeBMTEwgGo02PKMvMvbW1tZw7949nDlzBlarFXK5nMeytFIKWziu2EKuVCrhdrvhdDrh8/kwPj6OjY0NnpHE2vwGg0GkUqmGcSl0D5AQIAHwzi3+wgnB4XBgdHQUHo+HD8aD8rfZDv/p06d8p7DbgN3a2sLTp09x6tQpLgAOEhj1eh12u533IlhbW+Pdv15XIJmwsA8TA/tZCFi6nl6vh9vtxvj4OD766CNcunSpwdd7mPNJJpN8Z7OXSHhZz4dYLIZcLsfOzg4ePXoEm80Gq9WKK1eu8Oj+g8SlSCSCx+PB1atXsb6+zhuyHFQL/l0Zd1arFQMDA+jp6YFSqdz3mRBaTqLRKE+z3U1s1mo1RCIRLs6dTie3EBwkSgwGAwYHB9HT04O5ubmGHfSLCMpkMomJiQncvn0bLpcLPT09h2ofLTz/5hLcIpEIBoMBBoMB3d3dOHXqFILBIBYXF/HkyRNMT09jYWEBgUAAqVRqV/cAQQLgnZqI2ABgpt2RkRHYbLYDF0E2cWcyGSwtLWFubg47OzvPTCRsEdje3sb09DQCgQB6e3shk8n2DSRjGI1G9Pf3o7+/H/Pz8wiFQq9VAMjlcuh0OphMJpRKJd6UBPgtkEsul0OhUEChUECr1UKv18NiscDj8fB2wL29vTCZTPu6WPYyo7JdXXNq5avYwQjLwdbrdcTjcdy6dQsmkwlGoxEnT55sKBvbvJgLzc0KhQLDw8P49NNPEQwGkclkkEwmn9nNvWtWN4VCgc7OTi5ymyPfm+8Hu065XA6rq6t4+vQptra2+GcyccoEfCqVwuLiIhYXFzE6OvpMJ77m72N/MqvE0NAQHjx4gNXV1edeLIW/V6/XEQgE8O2338LhcMBgMMBqtTa4BFt9DoTPW/OcIBaLodfrodVq4fF4cPLkSQQCAczMzODx48eYnp7G8vIyQqEQKpXKM24BggTAO7MTAQCbzYaBgQEenLObf144oNlOYmtrC3Nzc1hfX28oadtsMszn89wNcPr0abS1te1pSmyuHsfSEh89eoRIJLLvsb3K68QKtVy5cgVmsxnlcplfB5bap1QqoVarodFoYDQaYTKZYLVaYbfbYbfbYbFYeBBdqzvgWq3GfycajWJmZgaLi4vI5/NHch1YjjgAbG5u4scff4TNZoNer8fg4GBDvMdeKWa1Wg16vR6nT5/G6uoqQqEQHjx4cOgyyG8T9Xoder0efX198Pl8vOLmXlY34aIdj8f5blZYSbJ5kWbBgIuLi4hGo9BqtQ0xGvulBDqdTgwODqKrqwtbW1sN3/O858tcE48fP4bVaoXZbMbVq1d57whh34PDftduAkUsFkOtVkOtVsPhcKCnpwcnTpzAzMwMJiYm8OjRIywsLGB7e7uh5TZZBkgAvDs3TirlqT92u73Bj7hfw4xyuYylpSXMz88jFovtOXiE5siFhQWsra3tWxOgecLT6/U8NmFubo7XOD+KIDLh+ctkMni9Xnz++ee4dOkSFyJswmJtguVyOZRKJTQaDS/ZKzxWYR3yw+x0WEDew4cPeW2Eo4imb27tu7Kygm+++YaLABYwul+OOXvZ7XZcuXIFW1tbCIfDWFlZead2XLu53YaGhuB2uxsW5oNy/zc2NjA9Pd3gdturNW40GsXi4iLW1tbgdru5m2G/WACRSAStVsutADMzMwiHwy9kfRMu7PF4HLdv34ZarYZEIsH58+dhNpuf2yW011wlFBSswRnLwBkbG8PIyAhu3bqFBw8eYGVlBfl8nhZ/EgDv1iSk1+u5mZ21pt3NDNlsNmQlR/1+f4OPUDgJCQdmKpXCwsIClpaWMDQ0BLVavevnNsPSflhKYCaTeS2DlPU0Z2lae71nv93LYSZP4TlWq1WsrKzg1q1bmJiY4O4WoRvnKHaszJozPT2Nr7/+GmazGdevX4fFYmkQN80litnELpFIMDAwwFMDU6kUYrEYX/TedmtAs9uNCW9hXMx+1x74LevG7/djZmbmGTdQ8/vr9TrS6TTP0hkaGmqIM9jt+IT30O1288qA4XC44Tl/nudOeIybm5v49ttvUSqVkEqlcOnSJbS3t3NRKxSU+7lGDprndvtdo9GIsbExuN1uboH57rvvMDU1hWQy+UyRJoIEwFtpgmTpdr29vejo6GipKh2zELAGJKFQaM+dipByuYz19XUsLS0hkUhArVYfmGHAJjK73Y6+vj54PB4Eg8GGbIOjnsBbjVYW7kCEu5SDdjm7WQkCgQB++OEH3Lx5E2tra7vu9F71syKc+NPpNB48eACLxQKn04nz58/zjIbddonCSV2pVOLEiRP45JNPsLa2hjt37hzY8vZtE9/Ab8F/vb29vOLmQefPrmE0GsXS0hIPim0lhiQcDvOUPuZ+axYWu91zk8mE3t5edHV1YXFxkWcbvOh9Ys/RxsYGvv/+e+zs7GB7exsXL15EV1cXzGZzwzgTZtocRgw0d6wUjkWpVAq73Q6j0QibzQaz2Qy1Wo179+4hHo83iCiCBMBbuQvRaDTo6elBb29vQ+W/g3L/c7kclpeXsbS01FCBrHmwNO9KWL+A9fV12O12XmBmP/MxM0ey/gDz8/MvbI58kYXwoF2BcIJqNdBvL5NmvV7H+vo6vv/+e/z973/HkydPGiotHvUORWjVCYVC+OWXX+B2u2E0GjE6OnpglDk7J5vNhkuXLvHCLaVSiZcKfhdg7qTBwUE4HA4uqg+yglQqFayurmJxcZEvUru5gYT3iRXhYX06fD4fd0sdFISrUqnQ2dmJ/v5+TE5OYnl5+aUsiEK3UigUwo8//ohQKITl5WVcvHgRo6OjaG9vh1qt5k1+9ppXDjOedhvHrHeFTqeDSqWCWCzG7du3G+Y1ggTAW7cDAQCz2cwDfYQm+f18/wAQi8UwPz//TBDSbgNTuLgnk0kuHISi46CaAADQ3t6OsbEx3Llzp8EceZQqvZUd/H7X+6BJkQUGskl9eXkZ3377Lf7nf/4Hd+/efW2TkjDITLjIBwIBfPfdd2hra4PRaITH42m457t1K6xUKjzu5IMPPsDKygqvM/C2RmE3Pwc6nQ79/f3o6+trye3G/mQlt5eWlhrq3x8kBHO5HPx+P5aWlnDy5Em43e49f6/5XjscDgwODsLr9SIQCDxTe+Jl3K90Oo3JyUmEw2E8ffoUp0+fxunTpzEwMACXywWTybTrbl6YcnuY8dYckyMSidDR0YFPP/0UwG+9Te7evcvjjSgwkATAWwMbsCyqvb+/H3a7/UCzIPu/arWKra0tLC4uNvhv9/pd4QBlv+v3+xGLxQ70fTabI5kbYG5u7lAthl/lZP6yEO50dnZ2sLi4iB9//BFfffUVHj9+zPP+35TJSCKRoFwuY3Z2Ft999x3sdjsMBgNMJtOuJtvm+ymVSjE6OooPP/wQlUoFGo0G5XL5rTa5MmFksVjQ19cHr9fbkkuJPeOxWAwLCwsIBoMHVtETNmhiboCVlRWEw2E4nc6WhaxGo0F3dzd6enowMTGBZDL5Uu8RE5SseVgkEsHKygqmp6cxPDyM4eFh9PX1cSGg0WieuWZC8diqGGjOnGAFkK5du4bt7W0kEglMTk7ygGiCBMBbsRNhD7zBYEBPT09D5b/9diLCIKSVlZWGCmStCA4GK06yvr7OC4HsZ44UVkzzer3o7+/H1NQUAoHAgYWKjosgY+dZqVQQDofx8OFD7vOfm5vj5XPfhLa6zRNtOp3Gw4cPYbPZ4Ha7cfbsWR5otptrh91v4Lf003PnzqFUKkGpVLYcX3GchTczqzc36dnP7SYSiVAsFhEIBOD3+3mb31a+T1jHYXFxEX6/n/ccaH7fXsLU4/FgYGAATqeTV9N7GYsi61sgvAaFQoG7hiYmJtDd3Y2BgQH+8nq9cDqdvKNgc3nfw86HwvLJEokE7e3tuHbtGjY2Nnj1SuH5UkwACYBji3D3yGrts/rje00EzRNJLBbD8vIyNjY2eC588+BoNucKB83Ozg5mZmYwNzeHsbEx2Gy2PdPImhdJu92O4eFh3Lt3jwfDHaU6389M3dwS9zCLf7FYRDAYxPz8PB4+fIhff/0VT548wdbWVsv901+XCGDtZ2/dugWPxwOTyYShoaE96wM013no7OyERCJBqVRqMPW+Lbuu5sXJYrFgeHgY3d3dUKlUewql5nGTSCR4fftCocDF0m7+8eYMEuA318v8/DyePn2KM2fOcAGwXz0Odu8cDgf6+/vR2dmJQCCAXC730sde83UqFAq8k+T8/Dxu376Nrq4u+Hw+/mpvb+eWAeExC11QrQYLss2RTCZDf38/Lly4gNnZWSQSiVfadIsEAHHkyOVyeL1evgthfeYPWrzK5TLW1tYwPz/PG5AcJDhYhTy5XA6ZTAaVSsXrDRQKhUPtnljQYk9PDx49eoRMJnPk5v9XsTCx4K6vv/4a33zzDVZXV3lqJbsnb5oPkk2yrJTr2toabty4AafTCavVyoPb9nMp1et1bmJmdQ3Y+b6NZYKFha2EbrdWCAaDmJ2dxdbWVkPL293GIBt3UqkUSqUSUqkUCoUCTqcTMpmM//5+11goyuVyOTweD3w+HyYnJxsCUV+2hUQYOMuaCEUiEUQiESwvL2NychJ2u52LAZbC3N7eziP5hZakVoUKC8RkTawGBwcxPj6OmZkZBINBcgOQADjeuxDhImIymdDf34/u7u6GFr177f4Z6XQaCwsL8Pv9vFc4a2fLCuGwingajQY6nQ46nQ56vR5ms5m/WLMRjUazb+Wv3czH7e3t3By5uLh4pOa5/cylh90RCXfHzIqSTCYRiUR4lT82Cb+pZkfhORSLRUxNTcFut8PlcuGDDz7gNRP2EwGsocvbPPbYuGPFdfr7+3n1u72ef+E1YyWgFxYWeCAoE1fCcadQKKBWq6HX6xvGHWvgZLfb+XcfNqXO4XBgZGQEd+/exdbW1gu1CT7oeRIek/Dz8/k81tfXsbGxgZmZGZhMJrjdbgwODmJ0dBSjo6Po7+9HW1sbt648r8hvb2/n2QhbW1sNVisKCCQBcGwnIalUCrfbjYGBAbS3t+87+JsD/CKRCA/gE04wWq2Wl75lE47RaOTNOdh7tVottFotNBoN1Go1lEply5NQszmyu7sbGxsbKBQKe6ZDvewdbzqdxvb2Nhc/wslJpVLBYrG0XOdfWCVPLpfD5/Phvffew+rqKu7fv49cLncsJhuhKyCVSuHu3btwOBxwuVwYGxvjtSXehTz//cQ3W0T7+/vh8Xggl8sP7Mwn7KWxsrKCUCgEuVwOg8EAs9kMnU7H/242m2EwGHYde0yMq1QqaDQaaDSalk3j7DiMRiMGBwfR3d3Ne38cxbjbzQpWr9eRy+WQy+UQDoexvLyMhw8foq+vDydPnsTp06cxMjICp9MJqVTa8rMn3EgYjUb4fD54PB48ffr0pdVAIAFAvNbJWq1Ww+v1oqenB0aj8ZlBtt8CWC6XodfrcerUKUgkEm7qZROQyWSCyWTik45SqYRKpYJMJmupyNBBEwBbaDs7O9Hb24upqSmuzl81lUoFGxsbuH37Nubn51GpVCCTybjZ0Gg04sSJE3jvvffgcDhasgwIa6+3t7fj448/RiaTQSKRwNOnT3mt/DdZCDSnY21tbeHWrVvo6+tDW1sbOjo6AID3q9/PsvI2TrDsfKRSKXe7WSyWltxu7D35fB4qlYpHxFutVjidTt6emQlPnU4HrVYLlUoFhULBzf8v4x7L5XJ0dHSgt7cXdrsd6XT6lYq63USFsNImE0mVSgXb29tcJM3OzmJmZgZXrlzBlStX0N3dvW+K816WUlYoyG63Q6PRkAAgAfB2YDab0d/fD6/X21AXfD8TPBtwFosFly9fxpkzZ/hOg+0sFAoFpFIpN2e/7AAhoanf4XDwHGGhAHjZKYHCTnfVahUbGxv44YcfcOPGDRSLRSgUClSrVdRqNeh0Oly8eBEymQyXL19+xsS7nwBgeL1eXLlyBcvLy0gmkzzQ8U33hwtTqSqVCvx+P27cuMGLBOl0umfKzO61S37bFn5hi92+vj709PTw3P+Dxh1Dq9Xi1KlT6O7uhk6ng8VigU6ng1qt5rE1Uqn0lcWosAh5i8WCgYEBdHZ2Ym1t7ciC43YLJt7tPLPZLObn57G5uYmVlRVsb2/js88+w+joaEvVFtl3sPNlG5qD2jQTJABeeLJ4VYNXOPFKJBK43W709/fzFKSDKrcJ1bfVaoVer4dYLD5U2tZukfOHPV+hOdJgMPASpfPz8zwY8FXWBGBmx2g02lCIiBGPx1GpVGC1WmE0GnHmzJmGdrl7TR7C3YxMJsPg4CA++ugjbG1tIZFIPLPTetPTkEQiES8V7PF4eLtb1jr5XWr7K2zPy0pusyI8By0mwqwS5mYTiURQKBSQyWRHMu6a38fahvf29mJiYqKhFsfrejZ3q/C3s7ODiYkJnqWk1+vh8/n2rVfSPBaB36oEMksmQQLg1V28/xfI8zLMdfsJAI1Gg66uLvT29vIAvFZhfd0VCkXDzqBVAbHX35/XHNnZ2QmfzwebzdYgAF4lEomE77hY1T42wVcqFYRCIfz0009oa2tDW1sbr3PQSnlcdj11Oh3Onj2LtbU1rK2t8WIkR+FrfRk7RXYPQqEQ7ty5w+8R63f/ruVR1+t1XsOCud0O0/KWLfqtjLvd6mm8jHEnFCNutxu9vb2w2Wy8ENjruq67zVESiQS1Wg3FYhFPnz6F2WxGX18fHA5HS1Y54WezDIhXMS+/bYjflRN9mbt1ZjpVKpXQarXPVQyF7TL28hHv1lSns7OzIff/uW/6/0vbEr4kEgl/Cf//ZV03tvA6HA709vaivb0dcrn8SM1zrIAJu+YsDqBarWJhYQE//PADbt261dCudb8dUnM50/b2dly6dAlXrlyB0+ncd1f2pi127M9KpYK5uTl8//33r62D4eueJxhmsxkDAwPo6uriWTcvIlj3GnPs769i3LFzslqt8Pl8/FyeJ0vlVVk8a7VaQ4okKyo0OzvLK2k+j+gXuuDIBUACYNcB9iKLqEajgdFobOiQ1+pnVioVFIvFZ/KBm4+L5f739vbyEryH2YkITYrN3bVaGRzC32W/3/xqZdJgsPxxn8+3byrjUS187PgKhQKePHmC77//HtPT08hmsy2ZSJsL5AwMDODatWs4ceIEdDpdg5/9uIyRnZ0dPHr0CD/99BPm5+f5M/q21vzfzaojFKttbW3P7DBfxrhr9Xf3GnetfJ6wIierDChsIPa8zwhbYF/WuBVed5FIhGw2i0gkwgXoQWKcIAFwoMqsVqsNO8DnEQFCf5TZbEZbW9szwVKtUCwWkc1mD+ymptVqud9caE58XuXevLvYq4HQXn7I3awHh1XmHR0d6O/vh81m2zfI7FWaH4WTKFu8Y7EY7t27h59//hnLy8vcNH7QfWXXsVqtQq/X4+TJk/jggw+4//I4TFrN7Y/D4TB++eUX3L59m8dOCJ/9t10AsKwVFvz3POf8usdd89hiVUSdTudzjTUmRF7GPNqK8BF+B0EC4Llhvvpmk1Dz4DzMYGb+wc7OTl6TXzggDtotZjIZ7OzscAGwV9vLtrY2DA0NcV/sy57099pdNC+Qz7OL2cvKwPKqWUbDfkVnjnLhq9VqWF1dxU8//YRff/2VuwKag4z2OzcAcDqduHr1Ki5dusRTC3frtPemCQDhq1QqYWZmBj/99BMePnyIVCr11u/CdnO79fT08GCyl73INY+zvcae8O+tWu6Ec5Ywo4FtJoQZDa2KCVYZVGjt3E2cPM9z3vw5crmcZ0y8yDUmDlgb3wVznsViQUdHB6RSKSKRCO9l3ryzPyi3l+XUA4DVasWJEyfQ29t74M68+UGsVCrY2dlBKpV6pmZ8c19vFoRksVgObfoXfvduKTnNwqZVS0q5XEalUuER8DKZrKXJiB2/Wq2Gx+NBT08Ppqenj6wmQCvPTLlcxvT0NH7++Wf09PRAr9dDrVa3JFKa65JfuXIFfr8fqVQK2Wz2WFgDhFkZ6XQaExMT6OzsREdHB0ZHR3msy9uUGdB8HqzoVm9vLxwOB7+vrVq7hPd4r78fdtyx+AzWeZEFtrb6GfV6HQqFAh0dHfD5fGhrazswCFe4YVEqlQ2/t7GxgUgksmvPCyYCDvuMCHf8VqsVnZ2dDTVPWhVhwkyOt120kgA4yMQhFqO7uxuffvopbDYbVlZWcPfuXSwtLSGZTKJYLLbkyxY+XBaLBe+99x7ee++9hp15q4OxUCggkUggkUjs2TSG5e/39/ejo6OjITXtedR1q5OEcCdSrVZRKBRQKBRQLBaRz+eRy+WQTqeRzWZ5a+Kenp6G8sAHLS4ikQhtbW3o7++Hw+FAKBR6JSVKD4PQehOPx/Hw4UP09PTA5XJhYGCgwQpwUH2Aer3OXQHLy8sIBAKYnZ09FuZMYZU4ViDo9u3bGBgYgN1u5+bjl9VZ7k2Exal0dXU1FKN53vmn1edP+CqVSsjn8ygUCsjn88jn88hms0ilUqjX63A4HOju7ub+/FbGHksJ7u3thcfjQSAQQKVSaamWiMFgwOXLl3Hu3Dnk83lMT09jamoKwWAQ29vbyOfzfAF/keecpV6ePXsWo6OjPAPgMEKOzVtvYkMuEgBHtOgL2+cODw/j008/hc/nQyQSwfj4OB4/fozZ2VksLy8jHA5jZ2enIRJ1NxQKBdxuNy5cuIDf//73OHXqFK+b3oo6ZbundDqNSCSCZDL5TFtN4UTDau/b7fZnFtFWzbkH7TbK5TIKhQJyuRyy2Sxf4NkrlUohmUxyi0U2m0UsFsPOzg7UajUuXLiAP//5z+jp6dn3GJv/LYywnp+fRy6X47us1yEAmo+ZuQJ8Ph+sViuPV2Dpg/tNQOxPr9eLixcvYnZ2FtFoFNFolD8HBzVkehOsAKxXwNzcHH7++Wd4PB4YDIYGi8jLNI2/7nN+UbfbbuNur+vDgoBzuRzy+Tx3CbI/2SuZTPJxl06nEQ6HIZVKce7cOXz55ZcHCoDmfiI6nY63E5+YmEAymdy1XkVz1ofdbseZM2fwxRdfQCKR8K57CwsLWFpawvr6Oq+BkclkeKnvlhciqRRarRadnZ24ePEiPvvsMwwNDUGhUBzoPmtuSJTJZJBMJltuWkYC4C1FIpHA4/FgeHiYR9FbrVa0tbVhZGQEfr8fc3NzWFpa4i0sM5kMSqUSn6AlEgmUSiV0Oh2cTieGh4dx6dIlnDp1Cjab7dDmqWq1iu3tbQSDQSQSiWcGiTAIyev1wufz8RagL7LjZxMO28WziSaZTCKRSCAejyORSPAFP5lMIp1OI5PJIJPJ8N1IuVxGNpvlFfVEIhEuXLgAj8dzqPrxLCq5q6sLJpMJ+Xz+jTHTSSQSFAoFzMzM4NatW9wUyQq5tGI2rdVqkMvlvEWp3+9HMpk8FruSZlfTzs4OHjx4gK6uLl6P4qDiLMcVuVzekDN/mPPbbdzVajW+gxfu4tkYi8fjfJGPx+NIpVJIpVLIZDJclBcKBZRKJRSLRaTTacjlctRqNYyMjGBoaAgqlaplkzvrbMjM+aw3wEEWEeaKZBkRZrMZXq8Xp0+fxubmJtbW1hAIBBAMBhGJRBqEQKlUQrlcfiZwkHUc1Wg0sFgscLvdGB0dxblz5zAwMNDQZrqV+ZVt/FiJYVYGmFwA76gAUKvVGBwcxMDAQEPuq9VqhdVqRV9fH06dOoXNzU1sbW0hHA4jHo/zBY5NCHq9HlarFe3t7ejq6kJHR8eBHdP2mlSLxSLW19cRCAR4YJVw58/+tNvtvHc2y5dv1ZzP/PRswslkMnyBj8ViiEQiiEaj2N7ebpiAmGmfTValUmlPc55YLEapVMLa2hqWl5cxPDzcUpVCoVpnRXfa29sRDocPtMAc5cLHXAH37t1DT08Purq60N7e3vLCx54Ns9mMM2fOYH5+Hqurq9jc3DwWFQKbg6gCgQB3BVit1oaU1OOO0HVjNBrR3d0Nj8fTEP3f6hivVCp8/DALWiwWQzQa5X9Go1E+HpPJJDKZDLLZLF/sC4XCvvVBarUa1tfXsbS0hEgkAq/X27BjP6hMscViQW9vL7xeL9bX1xtaWO+2IbHZbNwFxCwlIpGIl9z1+XxIp9OIx+N88WUCRzifCNOeWYEylkrd1tYGt9sNr9eLtra2Z+a8g667MH1wbW0NwWCQnxcJgHdEADSb0O12O0ZHR+Hz+Xgkr9D0ylJ9XC4XSqUS71Ql9B9JpVKoVCpotVreCa+VrnF7mQUTiQQWFxcRCAR4f2428JiClUql6OzsRF9fH2w2W0tmcbaoVCoVbG1tcdNcOBzm7WrZhMN29+xcK5UKT+1pdaCwcwqFQpiZmcGZM2e4ADjo/jAzOotK9vl8mJmZQTqdbliAX0ckr/A7WYGgW7duYXBwkLdrPczOVyaToa+vj7sCksnkK+nL/ioQumQKhQKmp6fxww8/oKurC2fPnuV17I+zFWC3DI7BwcFnGkPt5ssXnjfbec7Pz3O3IlvoY7EYd5sx1xobd5VK5dB+82q1ilAohMXFRayvr8Plch1Yslk4N+p0Ot6Y68mTJ3yh3Mtl4XK5MDg4yN1gzZsQsVjMuxi2t7fzYMVSqcQtF2zxb7YAsMZjarUaCoWiYeE/7JgViUSIRCKYmZlBIBBAsVh8xgVCvAMCoFarQalUoqurC4ODg8/40JkIYKknLL2Fpca0+sC1EuAj3PGyznRPnz5FMBjcc3ETBiGxYjmtRiHn83lMTk7iq6++wsTEBOLxOAqFAjfjC90b+5kxdzO9NccUVCoVpNNp7gMcGho6VEVEqVTKO5WZTCZeP/9NWPjYeeZyOUxPT+P27dvo7u7G0NBQw/XYa8IVBtLp9XqMjo7i7NmzWFpagt/v37Vv+ps8rkQiEWKxGO7evYuRkRF4PB60t7fzBemwlTDfxE2DsHNeK8FnwvtfLBaxuLiIv/71r3jw4AHi8TjS6TR3ubEF/6BjaR7jzc8Hm0ey2SwCgQACgcChguXYvMUsjG1tbQiHww2LqPA7WRfS7u7uhvlR2OJXmA7IsoJUKtULj7/DzK8sg2dlZQWTk5M8sJiNQ7IAvCMCgOFwODAyMvJMhHpzup9QGbZSZ5o9mIdJ32GTYyQSweTkJJ48eYJEIvHM+4QpMD6fD263u6GByG7f2WyijEajePDgAb777jssLS0d2FRkv4Ike5nO2HVkO8NAIICVlRUkk0neMrWVDnIikQg2mw09PT1wu90IBoPcCvE6K+cJJ3YWCX/nzh2MjIzwTnkHRcI3u3XcbjfOnz+PqakphMNhZDKZPc2ub5orgB1ntVrF6uoqfvnlF/T09MBqtTZ0pmzVKvamnqPJZEJXVxc6OzsP7LjZPDYSiQSmpqbw/fff48mTJw0icq/03d3GnnBh3e94y+UygsEglpaWEI/HYTAY9hWmzULCYDDA5/PB6/ViYWGBB+2x42TPtsPh4HORsHS38HyEPTH2O79WF/LDpFsKg3I3Nzfx4MEDTE5OIp1O0+reAm9VISD2EMlkMnR1deHEiRPcb9scKbrbjvegkq+HzdsVmrxyuRympqZw8+ZNLC4uolQqNfiT2YsF/7EgpMOIk2KxiNXVVczOzvKWtPtNWs3f3ZyzvNf1EP6MNdNZWFjA+vo6TytqpZEOSy9ipYGFu5g3ZSFhZYKZFWB+fp7XQGilDDI7T61Wi7GxMZw9exZer/ellKM+qjElvJeZTAYPHz7EzZs3sbq62hChfZx3WSz3nzWgkUqlh3JtBINBzMzMYH19fdf8873G4m6Cu5UYGib2WRvdUqnU8jzGdvasQ6BQtAs3N2KxmFtEhFkwuwn55jnyMM/D89Y3EbpOUqkU7t27h5s3b8Lv9zc04qLd/zsgAJj/nNXwPn36NE6cOAGtVst3lXvtZltZ3FsVAMIHk5nEmC/5xo0buHfvHpLJ5J67eb1ej56eHnR2dvJ0q1YXxGw2i5WVFb4QSyQSbpITNhvZawLaqxTpQZNJMpnEysoKVldX+UR00L1iSCQSOJ1OHu9wUO/w1/FcAb+1DX7w4AHu37+PeDy+6w5or+vDFkmW3zw2NsatUsdlchJO0sFgEHfu3MGDBw+QSCSORZ+DgyyGSqUSPT096Onp4UK0Vb8xE95+vx+FQoEX6ZFKpa9k3LFjz2QyWF1dRSAQOFTvCnYvWTaA0+nc9R4aDAYMDAygp6cHKpWK1wY5aH487Gap1d9prozI5rdcLoeJiQl8/fXXePToUUOMDS3+74AAEJqNJBIJvF4vxsfH0dfXd6iOc3s9xM+zEEkkEq6Y/X4/vvnmG9y4cYPXmN/r4WT9x51OJ9+F7LcTF57b9vY2/H4/tra2Gup1C1Nw9ior+jwLArvm+XyeZwM0Zza0spuxWCzo6+tr6LkuvB+vc+crNG8uLS3h9u3bmJ2dRbFYbKiKd9AzBfxWR2JoaAjnzp2Dx+NpMLUeB0uA0N+9sLCAn3/+GXNzc8ey4lrz9TaZTOjr64PX632msudebjL2//F4HH6/H6urqygUCnzsseDalz3u2PNSKpW4G0DYwXK/zQ7w/wVCG41GvtkQujyE9RB6e3u5K/KwzX/2m09fZH4Vzve5XA4PHz7E3/72N/z444/Y2tp64zNs3ijL19tyIkKzlUaj4SVc2f8JlWNzG9fn2XHuVuKz2c1QLpcxPz+Pr7/+Gn/7298wOzvLA4F2q3wnl8vhcrnQ1dXF0wyr1eqeg0QY5FIul7GxsYGFhYWGFpqvahA0f240GoXf70coFOKuC9YgZ68I6uaaByzfPpFI8PMW0tyBcLf3CCcx9v0v0sNA6OdPJpN4/Pgx7ty5g/b2dvT09PBd0UG+YmaRsdvtGBsbw/DwMDY2Nnhlt70axDTXhN/rfNmz8KLn24oAYGLz7t27GBoagsfjgdvt5s/rXgGBzCrWaifJvT6juaXzbteE/T/rM998TYQCVSKR8JRUq9XKP3uv4xOO81KphM3NTZ5x02oDqRcdd0LxsbCwgEAgAK/Xy2sE7DensTEpFot5zYNff/0V2WyWP2dSqRQ6nQ56vb4hoE84l+7mAnhR691+8yq7V+yzY7EYHj58iP/5n//BN998w92eJADeQQEgnBDC4TDu37/Pg3qMRmND69m9lHKrVfb2UqPC98TjcczMzODbb7/Fd999h8nJSeRyuYYqhc0mOVb6t7e3F1qtFiKRqCEIcD92dnawvr6O1dVV5HK5I/HJCiejVCrF89wHBgb4pNFKdLhYLEZnZyeGh4dx//59Xp2sOUBO2D8dwL49CNj3MvfHi0xIwsCojY0N3LlzB0NDQ3C73Q1pofudH/scuVzO0wIXFhYwNTXVIEybf48du1Dg7odMJoNUKn0lZvndAgLv3LmDvr4+WK1WXpDmoJ4aEomEm8cPK/LZ7x70DDS7mZr7wwvnDL1ej76+PvT19cFkMvH3tXINq9Uq1tfXsba2xgM7j9Kak8/nsbKygkAggEKhAKVSeWAqnfC6u91ujIyM8FocwgypVCqF6elptLW18YqkGo1mz+uyV9+RVtOl97IeNJPL5bC5uYmHDx/im2++wc8//4xAIMCFDaX8vWMCQKhIK5UK/H4//u///b9YXFzE2bNnMT4+zgNZ5HJ5Qx5/cxe+Vi0Ne+3EstksNjY28OjRI/zwww+4efMmH5zN3yFUqlKpFE6nk5vchIvfXgNIuNuKRCLw+/0IBoN8t/kqdoJ7DdpsNov19XWsrKwgFovxFLGD0hfZOVgsFvh8Png8HszPz/Mc3oNcCAdlRjxPgNF+55pOpzE1NYV79+7B5/Ohv7+/If6kFWw2G06fPo379+9jZWWFWwEOygjYzxXUHAH+KhahZgvXzs4OJicncfv2bfh8PvT19e0bif48C8NBO8v9noGDouKF94O5oGQy2YH3UvjzVCoFv9/PA/HYZx/VIsRSi9m4E2YDHDRuhIWPvF4v5ufnkUwm+Tlubm7i66+/xurqKsbHx3Hq1Cn4fD7Y7Xbo9fpnxNd+c+OLzKvsmPP5PLa3tzE7O4u7d+/il19+wePHj7G9vd1wTsQ7aAEQ3vh0Oo35+XlsbW1hfn4e9+7dw/DwMIaHh9Hd3Q2n0wmj0Xigr69VisUiEokEtra2MDc3h4mJCTx69Aizs7MIhULPpATtNklJpVJYLBbodDoUCgVsb2+jXC7vO5mzznOlUgmzs7MNA/ioLQDCokCDg4N8510qlfbd6VUqFSgUCt5i2WKxQKVS8SZNwqI8uVyO10hnbo/dPlvoUmHljFkXtRdd+NjEyCoEajQamEwmfq9auVZSqRRmsxk9PT1wOp38fJpTB4vFIi8ew1r07nW+bOddKpV4m+mjcP8EAgHcuXMHg4ODUCqVMBqN3OWx245boVCgXC5jZ2eHV9s8jJUvl8shlUpx995u38Peyywu7BnY7ZqwinZmsxmlUgnxeHzfQFbhsyASibC4uIi5uTnEYrGWxNrLvAfseYnH41hcXMTMzAyUSiWUSiUvZLafOGJd/kQiEaxWK7RaLZ8/2GaGufVmZ2dx//59+Hw+3lLY6XTCbrfDYDBAqVQ+Y618URHKyiinUilsbW1heXkZs7OzmJycxMzMDDY2Np6xupAAeEcFQPODV61WeeU7v9+Px48fo7e3F319fXynabVaYTQaodPp+APMTIV7Bf6w4J5CocBLfUYiEQQCASwtLeHp06dcfLAJTiKR7BmYI/y/ZDLJe69LJJI9O3UJf1cmk6FQKGBubg4zMzN8F3LUZjCRSMTbx8rlcszMzHBxctBuSi6Xo16vY2trq6E1sNDnnU6nMT09DbVazWMM9lsQmQDIZrN4+vQpQqHQM6bf5z3PYrGI2dlZfPXVV0gmk7DZbIcWADs7OwiFQs9YoNj7SqUSVlZW8OOPP2JjY4MLzYMEQLlcxvLyMjY2NhoKz7zMiVFYqCWfz2Nubg5fffUVIpEIz+Q4SAAsLy/zNMKD7gn7WTabxdTUFJRKJcxmMy/+cpAAyOVymJmZaRDjwu9jz1a5XIZGo9m3X0Nzuejl5WVMTU015J0f9dhj4/8f//gHFhcXoVKp9hUAQmQyGba3t7G+vt5w3kLhzUR3IBDA48eP4XQ64fV64fF44PF44HK5YDabYTKZoNPpoNFooFKpuLWVvfaL12GxHaxBUiaTQSKRQDQaxebmJvx+PxYXF7m1RVhHg1lcaPF/jvkMwFt31XZTgyKRiDf1aWtrg9PphMvlgtPpRFtbG394lUolFApFg3mLLfysRWcul0MikUA4HEYoFMLGxgY2NzcRiUSQSqVQLBafMXMe9HCKxWJotVrodDruP2/1ga7VarxbmLD+9VEjFouhUql44NBhi9ywRkPpdJoLGQazDhiNRt4HvZVryqoVbm9vv9RKgzKZDAaDATabjUdQH+Y6VatVZDIZbG9vNwQCsuOTSqUwGAywWq0N1SBbMe/mcjlej/0oFiOZTMYXAGFjmr3One3kt7e3kUgkWg6ck8vlsNlsMJvNDWWIW3kG2LVOp9PPxOCo1Wq+iz3sM8t2qPl8/rX6noXj7jCxFayiJ2sO1jzudrvGrI6/VqvlzyjrmGmz2WCxWJ6ZT1laZLPgZU3K2NyaTCYRi8Wwvb3N+7NEIhFsb2/vatminT8JgD0FwH51oFn9aZ1OB61Wy1WrSqXiD2yzABB202NNdoTd8vbKYaeH8+Xe14MG/m4/e5X34DAFWJrLKR9UUKiVksF7/ex1PHf71UfYzQX2MsZ3q88AjcUXv5+7XT9W01+pVEKj0UCtVkOtVkOlUvH/30sAlMtl3iugWCzypkjsxZoI7Sbs9iuyRLzDAmC3B1j44O1nLmIRw82R4+xh3aued3P0cyuV4g4acIflTSgs86IBaPudw4t+7qsSI6/yeF5GOtVRCrNXfXyv4hl4keC1d2Hc7TWPtjrPSaVSvvg3z6m1Wo3XS9jvu4VVU9+Ua04C4JjuIF/Vg/OyAu+OckJ9kxaFViZqGvRv7tg6invzKr7nqMTccRxzr2supbF/NEjfxZM+qNtdqzuFozIxE2/ujvhVLx7HwQLwvMd61FYAGqNHZ3lodU49aF6l+0YWgCOfuFrtCkgPJkEQxP5z6mGLq9G8SgKAIAiCIIhXiJguAUEQBEGQACAIgiAIggQAQRAEQRAkAAiCIAiCIAFAEARBEAQJAIIgCIIgSAAQBEEQBEECgCAIgiAIEgAEQRAEQbw+pHQJCOLd4U1pU/0mtsumFt4EWQAIgiAIgiALAEEQb8fOn71edy91sVjMd9sH9ZJ/164NQRzps493qBnQbl2paLATz/McvQ3PzVH3dD9u15R60BNkASAIYk8BeZyOXSqVQqVSQa1WQywWI5vNIpPJoFqtHrkFQKlUQqvVQiaTIZ/PI5vNolgsvrZrI5PJoNFooFKpUKvVkMlkkMvl3joBQHEOxDstAOihJ5530RKaiWu12rF4ltjx6vV6DA0NYWxsDDabDdvb27h37x6mp6dRrVZfqTVAuJNWKBTwer04efIkfD4fCoUCHj9+jMePH3MBcBQ7b+F3WK1WjIyMYHR0FCaTCYFAALdv38bS0hJ/33G3BgjdHOw+01xIvFMCgD3wzTs5GgjEQbwJvuoXwWq14oMPPsCXX34Jk8mEu3fvwu/382dfLBYfyTnq9XqcPn0a//t//2+MjIxgZWUF8XgcT5482XVxftUCQCQSwePx4LPPPsPHH38MlUqFGzdu4MmTJw3HcNwFAC34xDspANjAFYvF0Ol0MJlMUKvVqFQqSKVSSCaTr830SBw/JBIJpFIparUaqtXqGysMhAu6WCyG0+nE+Pg4Tp06hWKxiGq1ikwmg3K5/EqFsNBqAgAWiwWjo6M4d+4cnE4nNjc3ubn9KOcEhkKhQGdnJ86cOYOxsTHEYjEUCgVkMhkuEN6mWACJRAKJRMJFbbVaJWFAAuDtXPiFAkClUmFoaAiXLl1CV1cXYrEYfv31V9y/f7/B9EgWAeKZQSKVwmQywe12w2azoVarYW1tDevr6ygUCm/kDlH4LGu1WjidTrjdbshkMsRiMaytrSEajb7Sxb95sRWJRDCZTOjo6IDVakW1WkU4HEYoFEI+nz+S69i8oOt0OrjdbrjdbkilUiQSCayvryOZTD6zgz7OqNVq2O12uFwu6HQ6JJNJrK6uIhqNHnkMCEEC4MjR6XQYHx/Hn/70J/T392NhYQGhUAiPHz/mu6TnGeQvmlmwV2DZy5xw3pTsh1dxrq/q+otEIr6D1mg0GB8fx4cffoienh5sbW3h66+/RigUQqFQaGmXeBT3uXmRY+j1ejidThiNRtRqNQSDQayuriKRSBzpcyOXy2G1WmGz2SASibC9vY21tTWEw2G+CO13HV/mNWS7e6PRiLa2Nuj1etRqNWxsbGBtbQ3ZbPalbgqO8v43W4GYBej999/HhQsXoNFo8OjRI6TTaWxvb+9qNXrT55LXeV1JABwT2CAHAJPJhN7eXvT29sJsNgMAcrncc+/ghBaG3X52kM9tv99v9TNe5Bh3GyiHHdytvr95QXoZA/agczvo81q5fwyr1YoLFy7gz3/+M9rb23Hz5k38/PPPfLLc79xauQcve4ERiUQNufYGgwHt7e2wWCwQi8XY3t5GOBze1ex+2GemFdh10ul0cLlccDqdkMlkSCaTCIVC2NnZ2ffzW72Ghz02qVQKm80Gl8sFg8GASqWCSCSCaDSKcrnMr+Pz3pvme3KY4z5MtP5+cwgTXn19ffjiiy/w8ccfI5fLIRQKAQCq1WrDOe41D77Ic/Ei57LfsZAAIAGw74PEFlCpVAqz2QyXywWTyYRKpYJQKIRQKMSVfqsPzW5FQ3YbvHvtHJp/fy/Fvd9nHNUxsv8/aGDvJVbEYnHDtd3rc4SL1X7vEx4z26Hvdv3Y5+133q1cG7YA2Gw2+Hw+dHV1QSwWI5VKIRaLoVKpQCwW852T8Jqx32Xn9Cruc/P3CL9LmKVgMBjgcDig0+lQKBQQCoUQjUZRLBYbjrn5urVy7Q4j1IxGI5xOJywWCwAgEolga2uLm//3+i7hc7GfwDzs9ZPJZLDb7XC73VAqlUgmk9jc3OQCoF6vc8tEq8/yYY+9+XP3EsytbiZ2+x6lUgmPx4O+vj4YDAZks1kkEgmkUin+/O7lBmgu2rTXeNtPyLQqAA56727P327Hc5zTdUkAvAIrgEKhgMVigc1mg1QqRTwex+bmJiKRCEql0qE/b78Far/B3srkcdj3Pe/v7vaegxb8vXZ2z/vz3d530OBt5TP3e89hr41cLkdbWxtsNhvq9TrW19cxNTWF5eVlHjuy2/cJF49XdZ/3+x52TDKZDG1tbXA4HFAqldje3kYwGEQ8HufmYfb9B13bFzlWsVjMRbher0elUkE4HMbW1tYzQbitVAlsFqjPc1xKpRJ2ux12ux1isRjhcBhra2uIxWJc0O32+a0sMM/z7D/vdd7ru9hnaLVa2O12GAwGlMtlLCwsYG5uDqFQCNVqdd/n9CjGW6vvPczcSZAA4Gg0GjidTrS1tQEAkskktra2kEqlDr2rFj6EarWaFw+RyWQAgFKphEwmg2w2+4y4EE4oYrEYarUaOp0OcrkcUqmUD6ZSqYRcLodsNst3Ioc1O7LvUCqVzxxjuVxGOp1GOp1GpVLh58Ui3Jmir1arqFQqe6psVlxGuHOsVCoNkcUikQgKhQIqlQoqlQpyubwhCjmfz/Pr1crOn71HKpVCq9VCo9FALpfzXUyhUMDOzg7y+fye+dvsuJVKJRQKBRQKBeRyObcqlMtlpFIp5PN56HQ6OJ1OuFwuSCQSpNNpJBIJfr3Yi+2OhOfO7oFGo4FGo4FCoeDnXq/XUSqVkM1mkcvleDT+YaxQzZOiTCaDWq2GUqmEXC4H8Jv7YmhoiB9/JBLB+vp6g9lduMsDfouM12g0UKvV/LqwrIFMJsPdZs+z225vb4darcbOzg6CwSDC4TC3ROxlLpZIJFAqlVCpVFAqlZDJZFy4FItF5HI5fg0PEuhCDAYDXC4XLBYLarUatre3kclkoNfroVAooFQqUa1WecGkQqFw4DPa/MyxY2f3RSaT8etZLBb551YqlQZLDBuLhx2HbFyx94vFYlgsFrhcLpjNZlSrVSQSCWSzWcjlclQqFWg0Gi4EmOWoeTPACiVpNBrIZDJIJJJdx1uz6GPjg40tNj/sJRKF72fn3XxPxWIxH7fsPkmlUj7/sDmlWCwe+/RdEgDPaf4XDnaDwQC32w2TyQQA2N7extbW1jO+x4MWVfYwmUwmeL1e9Pb2wuPxwGw2Q6lUol6vI51OIxQKYW5uDrOzs9je3ua/xxYEm82Grq4u9Pb2oqOjA0ajEQqFomFxjkQiXKkLg6RacXmIRCJYLBZ0dXWhq6uLR10rlUrUajWk02lsbm5idnYW8/PzPBCora0Nvb29aG9vh1wux8bGBubm5rC1tcUnBmGgkNvtxsDAAOx2O98dz8/PIxKJQCqVwm63o6OjA263G06nEyaTCQaDgafRFQoFxONxBAIBzM7OYnV1FZlMpuF82L1k36lQKOB0OuHz+dDd3Q2HwwG9Xg+xWIx8Po94PA6/34/p6WlsbGw0LFYSiQR6vR5utxsejwd2u50fE6uOxxblJ0+eYGpqCkqlEm1tbTCbzajValAoFBgcHESxWEQ6nYZYLIZcLsfOzg78fj/8fj/S6TREIhHsdju6u7vh8/nQ3t4Oo9HIF+ZyuYxMJoOtrS0sLCzw63aQL5ZNgMKgOZPJBJfLhc7OTrhcLlitVmi1WojFYuj1evT29sLlcqFWq3HXVy6Xe+a51mg06OjoQE9PDzo7O2G326FSqSASiZDP5xGNRrG0tITp6WkEg0FUKpWWxg3bbTudTjgcDkgkEu7/F4qp5gJLSqUSNpsNXq8X7e3tcDgcMJvN/JiKxSLy+TzC4TAWFhawuLiISCTSIGqbj4edq0Qi4QujVqtFrVaDVqvF2bNn4fF4IJfLoVQqkcvlsL29jZWVFczPz2NtbW1XAdRs/dNoNHA4HOjo6ODHbjAY+DxRKpWws7ODUCiEpaUlLC4uIhaLoV6vw2w2o6+vD93d3TzjZGFhAdFotCGuibk33W43+vv70dbWhlwuh6WlJSwtLSGbzUKhUHArBxM0VqsV58+fh8ViQbFYhEajQblcxtbWFvx+PzY3N7kgVSgUcDgc/Dl2Op382SqVSojFYlhdXcXs7CxWVlYa3DkajQZdXV3w+XzQarUIh8OYnZ1teHaE49xqtaKvrw+dnZ2oVqtYWVnB4uIi4vE4fx6sViufUywWC8xmM/R6PeRyOReA29vbuHv3Lqanp3k2x1HVuSAB8AZiNpvR3t7OI30jkQhCoRBfbA7aeQlVsMfjwenTp3HhwgWMj4/D7XbzXSgAFItFRCIRPHz4EF9//TV++eUXHnAjl8vhdrtx8eJFXL58GWNjY3A6nVCr1XxnyD4jFArhm2++QTKZbEjV2WthEE6aXq8XZ86cwYULFzA8PAyn0wmDwcAtACwI6P79+/jnP/+Jn3/+Gel0GlqtFqdPn8ZHH30Eh8OBJ0+e4G9/+xt++uknHjHOvsdsNuPixYv48ssv0dXVhVAohH/9618IBAKo1+uw2Wy4cuUKrl69it7eXjgcDmi1Wr7QikQiVCoVpNNpLC8v486dO7hx4wYmJyf5oBUuUGyCGBgYwIULF3D27Fn4fD5YLBYolUqIxWJe22F+fh43btzAd999h/n5eT6ZqdVqjI2N4erVqzh16hTcbjf0ej0vSSuVSvlO96uvvkIqlUKtVuNR4mKxGG1tbbh+/TrOnj3Lj0smk8Hv9+Ovf/0rNjY2kM1m0dnZicuXL+PSpUsYHR2Fw+Hg95ktEpVKBWtra/jmm2+QTqd5Wt5BJmb2LGi1WnR1dWFsbAwnT57E4OAgv9dskWQCxWAwIJ/PY2trC5FIBMVikR8HO68TJ07g4sWLOH36NLxeL0wmE9/tlUolJJNJzMzM4J///Cd++OEHrK6uPhP7sNdumwUAWq1W1Ot1RKNRbG1tNYxBNkFLpVI4HA709/fj5MmTGBsbQ1dXF6xWK3Q6Hd9FFwoFnkp448YNlEolLmb3E1DMLdjW1ga32w2VSgWxWAyv1wuDwQCRSMStKOVyGfF4HIuLi/jll1/w3XffYW5u7pm0RXbsKpUKLpcLAwMDOHnyJEZGRuD1emG1WqFWqxt2qtlsFsFgED/88APS6TTi8TjEYjE6Ojrwu9/9DlevXkWhUMA333yDWCyG7e1tfr/YvVMqlThx4gT+9Kc/oa+vDxsbG/jb3/6GQCDAnxGXy4W2tjZIpVJIpVIMDg7CbDZzq5tCoUAul8OtW7fwX//1X9jc3ATwW82GwcFBnD9/HmfOnEF/fz+sVisUCgUXU0z4/vzzz/jXv/6F+fl5HldltVpx5coVfPbZZ7Barbh79y5SqRSfD4XXTyqVoru7G3/4wx9w8eJFZLNZfPXVV4hEIojFYgAAh8OB9957j88pZrMZJpMJKpUKUqkUlUoFarUagUAAlUoFq6urJADeVQEgXLTb2trQ3t4OjUaDnZ0dPgkelAEgVNpqtRr9/f24fv06PvnkE4yOjsJisTSYwFQqFZ9U2Pdls1l8//33KJfLcLlc+PTTT/Hv//7vOH36NLRaLfL5PDc3M2uF0WiEWCyG0WhsOJeDMgY0Gg1GR0dx/fp1fPzxxxgcHOSBX8zUrNFo+DG63W4oFAqk02n8+uuvSCQSKBaLsNlsOHnyJBwOB1KpFB9Iwu85efIkvvjiC1y/fh1yuRyRSAThcBjxeBwSiQS9vb34/PPP8fnnn8NoNHKzOqs9r9FooNfrYbPZ0NHRge7ubp6mdu/ePRSLRT7RiUQiuFwuXLlyBZ9++ikuXryIjo4OLmZyuRwkEgkMBgPa2trg8Xhgs9lQLpeRTCYRDAZRq9VgtVpx+fJl/Pu//zv6+/shlUp5DXrmh1YoFNBqtdytYLFY+CLBdo4OhwNWq5WbKuv1OlKpFDdbOp1OfPbZZ/iP//gPDA8PQ6/XI5PJIJ1O87RBjUYDs9mMSqUCg8HQsAAKd6q73WdmXThz5gw+/PBDXLhwAT09PdDr9SiXy8jn8/z6MReQSCTiZvdoNMo/Xy6Xw+v14urVq/j8889x9uxZ2O12Xg+/UChALpfzVEKPxwONRoNSqYREIoFEIrGr2V4YpCk0Q5tMJpRKJWxubmJra4uPQXZeGo0GPp8PV69exdWrVzE2NgaXywWpVMrN/eVyGSqVClarFSqVCna7Haurq9DpdPu6jYTHyRZGh8MBuVzOF1OtVotSqcTLI1ssFtjtdnR1dcHr9XJRMDMz80ycgMFgwNjYGK5cuYJLly5hZGQEVqsVIpGIu/UqlQpUKhXPyDCbzfD7/bwHgUqlgsfjwXvvvYezZ89ie3sbd+7c2TMOwWAwYGRkBJcvX4bH44FEIoFCoeCiV6/Xw+v1wmaz8WeMWXrY58jlcsTjcUxOTvLsB7vdjqtXr+LTTz/FpUuX0NHRAZlMhnQ6za1HzeOtWq0il8thbm4OAOByuXD27FlcvnwZSqUSKysrEIlEKJfLDQGyTJx3dXXhwoULOHfuHDY3NxsybeRyOXp7e/HJJ5/giy++4NYL4UsikXA3xV5jiHjHBIBarYbD4YDD4YBYLOb+/3g8/sxktdfnyGQy9Pf348svv8SXX36J0dFR1Go1+P1+PHnyBKurq8hms7DZbBgdHcXo6ChsNhsuXLiAyclJTExMIJvNYmhoiC9gGo0Gi4uLePToEebn57k7wm63w+l0olqtYmJiApFIZF+fGTOZMtP0H//4R/z+979Hf38/qtUqlpaW8PTpUwQCAWQyGTgcDoyOjmJ8fBwulwuXLl3C7Ows5ubmEIvFMDMzA7/fj5GREbjdbpw9exYPHjzA8vIydnZ2IBaL4fP58Mknn+CDDz6AxWLB1NQUbt68iYmJCWQyGeh0Ong8HgwMDMBms6FUKmFqagoPHz7E1tYWSqUSjEYjfD4fxsbG0NfXB5/Phw8//BDBYBCBQADr6+v8/rAc5v/1v/4X3n//fZjNZkQiEUxPT3PTqEKhgM/nw8mTJ9HV1YUTJ05gaWkJU1NTPNjTarXC5/Ohv78fKpUKa2trePDgAb82Go0GWq0WAPhupa+vjxfQSSaTmJ6eRjgcRqFQgFKp5Iv+kydPMDc3B5lMhvHxcXz22Wc4f/48pFIp/H4/Hj58iKWlJSSTSchkMl4Qp1AoYGpqiu/uDnLxiMViuN1uXLlyBX/4wx9w9epVOBwO5PN5LC8vY3FxERsbG0gmkzAYDBgcHMSpU6dgNBqRSCSeMbt7PB5cv34d//7v/47z589Do9FgfX0d09PT8Pv9iMfj0Gq16Ovr4+Lg/Pnz8Pv9mJiYQCqV2tdtwRZWZoZWqVRciGxvb/OFtlarQafT4cSJE/jss8/w6aefYmRkBHK5HNFoFCsrK1heXsbW1hYAoLu7G6dPn4bH4+FCMJPJNJiW94MVR2IL9NbWFubn5/k5VyoV6HQ69Pb2Ynh4GB0dHRgdHUUkEoHf78fKygrfQdfrdVgsFpw5cwa///3veb0IiUTCTfyrq6sIh8NQKpXo7+/H6dOnYbVaUalUsLOzwysPqtVquFwuuN1uyOVyZLNZbG9vI51OPxNfICys5HK5+DO6vb3NBa3RaOT+/0qlgvX1dW5WF4lE3OeeSqVw584dhMNhWCwWXLp0Cf/xH/+Bq1evwmazIRaL4dGjR5iZmUE0GoVYLEZvby/v6TAyMoJgMIinT59iYWGBW5W8Xi+MRiMymQzi8Th/XppdexqNhm+cZDIZstksYrEY3xipVCq0t7djcHAQDoeDi7CnT58iFArxWCObzYZEIoHZ2dmWLbwkAN7CGAD2YLHUI6vVCgCIxWIIBoN8wd0rD1y4K+no6MBHH32EP/7xjzhx4gQymQxu376N7777Do8ePcLm5iZyuRzfYdZqNVy+fBk2mw3t7e2w2Wy8EuGJEyf44v+Xv/wF33zzDfx+P3/QTSYTzGYzRCIRQqFQg194v/zozs5OXL9+HX/4wx8wODiIWCyGe/fu4caNG3j06BGCwSAymQza2trw4YcfQiaT4cyZM3A6nejq6oLZbEY4HMbMzAxu3ryJ3t5enD59Gj09PTh16hQePXqE2dlZOJ1OfPTRR/j444/hdruxuLiIv/71r/jXv/6F1dVVfs3tdjt3uSwtLeG///u/8c9//pMLGrbTu3btGr744gsMDQ2hq6sLp06dwq+//sr9hEajEefPn8cf//hHXLt2DQaDAbOzs/j2229x8+ZNvqjK5XL09/cjmUxCr9fDbDZznzjbbVitVpjNZshkMqRSKfz000/4y1/+gtnZWRQKBWg0Gu5OiEajXDw6nU4AgN/vx3//93/j3r17yGQyUKvVfAEIh8MIBoNwu928rKxcLsfMzAz++te/4rvvvsPq6irS6TTkcjm0Wi3PLGD3+aDJiu3M3n//ffz5z3/G+++/D4PBwF0od+7c4dHd6XQaPT09qNfrGBkZ4cfIfsbcNBcvXsSf/vQnXL58GQDw4MEDfPvtt7h9+zZWV1exs7MDtVqNU6dOoVQq4ZNPPoHJZEJXVxfsdjsWFxefqaS5VxAu8/+nUilsbm7yTAQ2wQ8NDeEPf/gD/vjHP8Ln8yGfz+POnTu4ffs2Jicnsby8jGg0Cp1Oh48++gjd3d3o6OhAJBLB8vIyQqFQg5Dfb9JnqZEGgwH1eh1Pnz7FX/7yFzx48ADJZBK1Wo1b/X73u9/hs88+g91uR09PD3w+H/R6PRcAGo0GZ86cwZ///Gd8+umnaG9vRywWw+PHj3Hnzh1MTk5idXUV8XgcDoeDC3Sz2YxgMIilpSV+/9mCrdPpUKvVsLq6ikAgwAOWhQKAWTdtNhtf/JeXl7G5ucmFkNls5imguVwO9+/fx3//93/zRkcs0LBYLGJjYwOlUgnnz5/Hn/70J3z00UcwGo1YXFzEDz/8gB9//BFzc3PcrD44OIhEIsFFS2dnJ7eosMWYuXw2NjawvLzM/fnNz7XRaOTHyc57fX2duxO0Wi3a2tp4wObi4iK++uorfPvttwgGg5BKpXxcVSoVBIPBhjoXZA14B2MAWKEPt9vNH6xQKIRgMNgQyLNfio/JZMK5c+fw8ccfY3h4GJVKBXfu3MF//ud/4saNGwiFQiiXyzy2QK1Wc/+wTCbjg4GZjm02GyqVCmZnZ/Hzzz/j/v37/CGv1WqIRqOQSqV8Z7nb7r/ZtGmxWHD+/Hlcv34d/f39KBaL+PXXX/F//s//wc8//4xwOMyjb2OxGKxWK9577z2cPHmSHyOLD4jH43j8+DGmpqbQ19cHm82G8fFxjI6OolgsctP/wMAA4vE4fvjhB3zzzTdYWFh4JuiSFVza2NjAw4cPMT093RCgFQwGUSwWuRnRaDTygCnmK+3t7cWHH36IK1euwGg0YmlpCX//+9/xX//1X5iZmeEtW+v1OnZ2dtDf34/3338fFouFZx0IfbN2u52XfGVWiY2NDe6HFAZZjY6O8rz1crmMxcVF3Lt3D3fv3kWlUuExA8xHzgLJWGBotVrlk+edO3dQLpcbYjlWV1d3vc/NEc/MymM0GnHmzBnuH9bpdJidncU//vEPfP3115ienkYqleLHYjaboVAooFarUSwWudm9WCxCJpNhZGQEn3zyCc6ePQu5XI6JiQn85S9/wT/+8Q/4/X4eRc12imNjY7h06RLPXBFmNewXAKjVatHR0cHN0NFolFspGEzAfv755+jt7cXOzg5u3bqFv//977h58ybvGVCpVHhAo1qthkgkQjQaxebmZkNQ736ppXK5vCH/P5FIYGZmBr/88gtmZ2cb4ho2NjZgMpkwNDTEg0ZNJhO0Wi2P/xgYGMD169dx/fp1tLe3IxKJ4MaNG/jHP/6Be/fu8eecmb5ZZggb78JjF+6aC4UCtra2EI1G+WLGYl32E1bMZ87cI3a7HTKZDJubm5icnMTt27exsbHBXVrs+arVahgaGsK1a9dw9epVGI1GBAIB/OMf/8Df/vY3TE5OIpPJ8PeXSiX09fXh4sWLcLlcPMNHLpc3bLxEIhEikQi/h82wVNv29nYuVLa2tnixKrFY/Ewp7pWVFUxMTGBychLZbJaLfGEmRKtikATAWywAmEldqVTyIiit5v8zE+nFixdx8uRJSCQSPH78GH/729/w9ddf82AZRrlc5j44FiXL/KisD7tMJkOlUuFpfsz0J1T3wgYt+1Gr1SCVSuH1evHee+9hbGwM9Xod9+/fx//8z//gu+++QzAYbPidUqnEU+CEUe8sFatSqcDv9+PRo0c4deoUxsfH4fP58P7778PpdOLMmTM4c+YMKpUKfvnlF/zzn//E9PQ09zkLo9KFhWdYdDa7L+VyGYVCAcvLy3wXbzQaoVarodfree/68fFxXLp0CQ6HA+FwGP/617/w17/+FY8ePXomf5xde2FAZjabRbVaxf+/vTd9ajPNzv8vEGgDtCDEDgKzLzZe2gttu7vdPZ2e6dTUpCtVqVTlZV7k3/j9F/kH8m4qScXu9rhjO15ojA3YZl/EIsS+SQIhJBDb90V+59QjGTDd7VkyfX2qpjJjx9Kj57mf+77uc59znfz8/GMjQRIOT580LBYLCgoKtH5eJlcJ/wPQ32Ms4ZIFV8qkpNe9UXCe9TkbFy6TyQSfz4fbt2+jvb1dxdDdu3fxH//xHxgcHEzJwJbrLy0thc1m0/D/6uoqDg8PUVxcjI8++gjXr1+Hw+HA1NQU7t+/j2+//RZDQ0PvTJjyPEQkJRIJJBKJ91YCGHe1LpdL3fbW19dV+Lrdbly8eBGfffYZGhsbEY/H0dnZqSJ7bm4u5Z643W6tKjH2E4jFYu9N/pNjQSntFF+Qubk5FcqySEsOifydvN+SMCqh/xs3buDTTz9FRUUFwuEwHj16hN///vfo7OxM6bdgMpngcrk0+VQqGNbX15FMJrVCqLS0FBaLBWtra5pXY2zsZEysNC6y4XAYy8vLmq8ju2q3263Wy/Pz8wiFQjr2jGMwPz8fbW1tuHHjBsrLy7G2toaHDx/i7t27ePXq1TuGTZIsKRVMkg8l96WkpCTF82FlZeXYeVcqDUpKSmA2m7G+vo7l5WX93eLjIonEiUQCi4uLWs1inA+506cA0InTYrFook9WVhZWV1f17PGkydd4fJCXl4eGhga0tbWhsLAQy8vL6Ozs1B2J7AAksae2tha3bt1CU1MTMjMzEQqFNNTpdruxs7OD3d1dOBwO1NTU4OrVqwiHw5icnNTd1vvc2NInM2Ofd7fbjfn5eTx//hw//PADlpaWNBNcamwbGhrQ3t6OpqYmmEwmrKysYH5+PuUsNxQK4e3bt+ju7tYSwk8++QSXLl1CRUUFTCYTenp6dIcTjUb1vkmSoSycy8vLWFpaSik7Mz4jqbOWBdJkMmnyWnFxMS5evIiamhrs7u6iv78fT548QX9/P3Z3d3USlonz1q1buHbtGgoLC5FMJjE/P69hYUnmc7lcGg4XNz/5HJPJpIu5w+HQsZOZmYlwOIyVlRVsb29rJn92dnZKBMBY3iV5DtXV1bhx4wai0SiCwaBOWEYHP2Pp23Hn/vKcW1tbce3aNZSWlmJjYwNdXV148OABBgYGsLOzo+WVkqBVUVGBkpISmEwmRCIRHftyfnv58mVUVFQgHo+ju7sbT548gd/v13sqY7GiokKrA+Q812ikle6PkV4HL0IqJydHd3fhcFjfwXPnzuHGjRtobm6GyWTCyMgIvv/+ezx79gxzc3Maqt7f39cy0MrKSuTm5iIej6t73/uOIozGOPJsJYJgLB+Uc/H9/f2Uun35bKlPz8jIQE1NDdrb29HQ0IBkMom+vj48ePAAL1680LNy41FIeXk5ysvLYbFYdD4y7tgLCwvVmEgW9JP8SiRilp+fj6OjI03ElTLUgoICLX+Wv5cEUBl/WVlZKj58Ph8uX76Muro6HB4eYnBwEI8fP0Z/fz8SiUTKXOLxeNDe3o7r16+jrKwMe3t7GmE6PDzUEmC73a7i+aTGQ3KEID4toVAo5Xcb70t2djaWl5exsrKCaDSqQlvGvszdFAK/QAGQ/uLLJC4Da21tTV3QRE2fVr4kZWfV1dUAgNnZWfT392N5eVmNaBwOBxwOh070X3zxBRoaGpBIJNDf34+xsTEtTZqbm8Ps7CxaW1vR3NyM3/72t3C73Xj58iVGR0e1bv007/z0P/d6vWhpadFrDAQCmhiTnZ2tZjn5+fnw+Xy4efMmfvWrX6G6uhrRaBRv3759p15WkgdfvXqFtrY2tLW1oa6uTsuXRkZGcO/ePTx58gRLS0sp91B2JYWFhcjIyNDOc+mTmDHUbvRcl8iAzWZDdXU1mpqa4HA4sLS0hOHhYQQCAezt7SEnJ0cjBpLY+MUXX6C9vR0WiwVjY2N4/fq1Zh5LqDQ3NxexWAzz8/NYW1vTHYkIGGOXuPLych07q6urGraWycXYDtgoniYmJrC0tASXy4WWlhZ88803WgYlzyYej7/jxJf+nOWaMjMzUVpaitbWVtTX1yMrKwt+vx8dHR0YHh4+tppFutxJ2F1sd6PRKJxOJxobG9HY2Air1Yrp6WmMjIxoCaeURsr7c+XKFXz55Ze4fPkyMjMzMTw8jDdv3mg5l4yZ45JqpR5e/P+Xl5cxNzeni57dbkddXR0uXLgAr9eLzc1NvH79Gi9evMDs7Ow7v0vq2qWCZWVlRcPep7XvNd5LoyXx3t4eFhcXVaQKslBJZnlubq4uNtK+2Ol0orm5GS0tLcjNzcXMzAw6OzvR09OjZ/oiJIwLXVFRkY4VY8henBIlSiUCweiNYYwmSIQnNzdXSwolsTIrKwuFhYWoqKjQsPrCwoJ2Xkz3gDCbzaisrERzczMKCgoQiUQwNjaGqakpbG9vawmvuApeuHABv/rVr9De3g673Y7JyUn09vYiEAggOzsbpaWlKC0tfSfaJkmfxndGDJmMHSKNJaLp72I4HE75PHHD5KLPCIAOagkVyrndwcEB1tfXsbq6qqHH0zywZdGorq7WRCGTyYSqqip89dVXMJlMyM3N1dBUVVUV6uvrUVpait3dXfT29uIPf/gDRkdHsbe3h0gkgr6+Pjx79gx2ux3nzp3TcraWlha8evUKr169wsjIiIZp3+dxbjKZ1GxGSu1MJhPq6+u1vEfKCktKSnDu3Dk1DIlGo3j16hUePnz4ziIiZ3bj4+MIBAJaby8C4/Hjx3j06JGGZmV3ZvR7l522iC5jf3WjCJCyO6lb397exvb2Nux2OyorKzUBT8L4N27cQEtLC+x2OzweDzweDyoqKlBXV4eqqiqdjB4/fqy7MJvNpqLEbDZrwp4s5se56sniZwxby5mk7JBl8jE+n/X1dfT09KChoUHPvqVEq6WlBd3d3ejp6cHg4OCZW7FmZ2ejrKwMtbW1cLvdiMfjGBkZUeGW3ktBIgCS5CaTqoSx8/PzUVNTg8LCQj37LS4uxqeffoq9vT3k5eVplzyj4ZXJZMLQ0BAePHiA7u7u9zppGq/D4/GoIFxcXNR/KwmFFRUVyMzMRDAYRH9/PwKBgObRyAQvWfJFRUUqMCVcvLW1deZjQUmMs1qtiMViWF5e1rC4MfJ2dHSkHQyl7FM66CUSCXg8HvW4ODo6wvT0NPr6+vRoUHbLx40pcR6UnaxsOCRfyRg2l02BccEWUxwZ08ZFVsaM/L3FYsHS0pJWgEjUSgS93FcxLRLR4na7cf36ddTV1cHpdMLhcKS8bzU1NbDb7ZiZmcGjR4/w9OlTrKysoKioSE2bZA5YWVnRBd1Yk28ymVISFcWrwijOjTlFBwcH+nly3JAu3skvOAJgPMP1er0aejzp/P+kBECxLpX8AREEv/71r/HZZ5+pNWlubi7y8vJ0dzAzM4OBgQE8evQIT5480WSbnZ0dDA4OIjs7G8lkEjdv3kRdXR18Ph9KS0vR3NyMxsZG3L9/Hz/88AMWFxd1oTFe50m/0WKx4PDwED6fD19//TV2d3dhs9m0LlZsXff29jA1NYX+/n48fvwYz54909Iq44uUnZ0Nq9X6TpLX0tISxsbGMDc3h2QyqbXw8jIbky4lGzfd791oeSoVA1LDHQ6HNfNcfOMlbHvt2jXU1dXBZDLpvZfM/YyMDGxsbKC/vx9dXV14/PixJh06nU6UlJSktKFdWFjQRSN9R2LcXeXk5KhjXygUOtaQyfhstre3MTQ0hLt37yIej+Pjjz/W51xcXIzW1lY0NTXh/v3779x741g0Cgs5I5Wz4YWFBQQCAXVsS79+yQ4vLS2F3W5PCdmL05z4VMjO8/bt27h48aLaCcuu12az6aQ7Pj6Ojo4OfP/99/D7/bqzTd95yfVInbsxIVR2d7LblkVPdn+BQEDdFI3HI/IuSH6JZIOLMEs35jmpz4U4EpaUlCAzM1OPRiKRyDvRHFm0xfdBjo6Wlpawt7eni6HT6cTOzg6CwSCCwSC2t7ePbfYlroZ5eXlIJpNYWVlRUyZJEpbExM3NzZSF0HhkJouiiFo5bpyfn1cBkJeXp9ctxxxG87P0+yS5CfKc7HY7Ll68iKqqKo3kyJiQBMZYLIbBwUG8fPkSDx8+xNu3b7G7u5ty/i8Og8bcGeNYt9lsGiGyWCyap2Asi5Ux5HA4UhIEf2onV/ILOAKQEKgxQ3Zubi6l//Vp2f+Syep0OnURtFqtmoEsXt5i5ykKfHx8HH19fRgdHcXS0pK22zw8PEQoFMLLly8RCoUwPDysphf19fXqbCUmHk+ePElJUDOawAhWqxUulwtut1sFiN1uR1lZmV6juOPNz89rE6SxsTEMDg5iZGREbYbl7FPOxBsbG/Hxxx+jublZjWrkvrrdblit1nfuo2RXS+KZsbuaJFcZowxWq1VNgOx2u1oUh0IhnRjsdrsuyh6PR4VCMpnU8G0kEsHq6iomJycxMjKCkZERzMzMYHNzEyaTSZPGxM53aWkpJbSaLqzsdjsKCwtT2tYuLCykZK2nj5/0Y4DOzk49tmhvb8dHH32Euro61NbWwul0qgFTR0dHyk4m/RnL9UgJowiYpaWlEwWMRDwkyS0SiWjyl+y6ZazJLlfsjqUiIZFIaP354uIi/H4/BgcHMTw8jLm5uTNV0YiQEhdOoxNhIpFQP4TCwkLk5uZq1rsxWSy97E1KayWsvbi4mCLq3+dI6HA4UFlZmXK0IxGJdJc9OeuWsXNwcKCCVhLdZIdtPF48PDxMya6Xd6O4uBiVlZWwWq36vXJUIFUqMl+JMBG/EmO+iOyay8vL9bhAolrGxEoRSgcHBzrmj2sBLdFMt9utolC+Iy8vTyMFyWRSx93y8jICgQAGBwfVM2JrawvZ2dkaFc3Ly9N3WjosnjRPy/OIRCKaN2Xc5Ij4FfFuFAg0/aEAeAexHpXQtSSiiGObcSEyDkpjD21pYiMZtgMDA7pzFGe7SCSCcDiMtbU1DU3JBGf8DplYotEo+vv71Wd/bGwMd+7cQXt7u5bzBQIBjIyMvLPgpGM2m7XJjOyeR0dHMTc3h3g8jp2dHcRiMUQiEaytrWF9fV2vUcKY8rJLow6TyYTq6mp8/fXX+O1vf6sJePF4HHa7HVVVVbhy5Qpev36tiVxyz4zhWZPJpMk8kpQkIkUmgsLCQjQ3N6O+vl57DwQCAaytreHcuXNwu90atZiZmVG/dPHRj0ajmpwn4dTV1VVEo1HdKcmEJB7mxhCjMRE0fVIqKirS3ZCEmY2JjOlOc+ktWSWSsbCwgPHxcYyMjODzzz/H1atX4fV6cf36dQwPD2NiYkLr8k86krLZbMjLy0NOTo66DkpJ3HE96+Xc3Vh2JxO39Aew2WwwmUzY3t6G3+/H1NQUNjc3EY/HkUgksLGxgVAohFAopKHo1dXVFNHxvl2X3HspvZRdqFgsSxRNqiYkgVLus/FMXxJuvV6v2trKLlkiM2fp0ud0OlFeXg6Px5MSZjceC0pkQwyMJAookRRJ7pNnkpGRoeNRduvG5yJi1+v1wuv16o7d2JBMjrTk6CwUCulxZfpnSTWBLLJiHS7RBIm8SJ+M3d1dFVbGRdh4nRItlAZBMzMzGB8fRygUws7ODnZ2drCxsYFwOKzziERfNjc3dSza7Xa43W54vV49MllaWnpnMyPPV3KGJFFRxpsci0jOgUTvIpHIj+rjQn4hAuC4+v3y8nJtACT1tvLCnZRhbwwDS8mPtAp9+vQpHj16hNXVVWRnZ+tkmUgktKOX0c5VPs/YU1yyiFdWVlLqoe12O27evKnnrgUFBZicnNSzz+OSxSSzX75L/PifP3+uO4e9vT1sb2+nXGP6jk12KhkZGaisrMSvf/1rfPPNN2htbUUkEkF/fz8ODg7Q1taG8vJyTQwUsw75PNl1FBQUpHguGGv1jQ2VLl++jOvXr8Pn8+Hg4AB+vx+jo6MIhUKoqanRDoaJRAJDQ0P4/e9/j/Hxcc22T+8EZwzPywQj4XNJGpN7bgznp48jh8Oh/v+SPS1969Pd2I77v/L9svNaX1/H7OwsotEobDYbPvnkE3g8HlRVVcHr9WJycvLUxTQrKwsWi0WrFYxNc4zXY6xekdwXY/6CVE6I70NmZiai0ShevnyJ7777DsFgUM/BpTJDbIVPinac9g5aLBbk5+drBEkiNSIipOLDeMyU/l4af58syCLqw+GwLi4nJVTK+JaFzuPxaERCFnRjxCE9a18aWUlWvrQLlsiJ0Q46vZmRjIGjoyM1fjLOR8ajELEhFkvgaDSKzc1N7UBo/A7ZnRujDyKExCZZIisSbUg/wkp/jjIuzGazvm///u//jrGxMb2GRCKhc57YJctzNIo+h8OhNuaxWAyhUEgFVvr3SgKgw+HQY5G1tTXdnEgESe6b+AkYP4/hfwqAdyYe8buXWvTFxUXMzc2ltK08yXwF+N/a7vTWlZFIRM1Wfsq5k7HMTyamYDCIt2/f4tq1a7h8+bLu6KX86H2fZ2y/K4lFY2NjehZ4GpKkJLun8vJy3LlzB7/73e9w5coVxGIxdHR04Ntvv9V8AHH8unz5slZE7O/vw2w2w+v1qprf3d1FMBhM6cgnOyuHw4HLly9rUx2z2YxgMIienh6MjIxolrKxpWk8HtfIyI8RhLm5uXoWKrt52UGkT6zy74wVBtI+VexVZZE5LXlPBJssAHt7ewgEAujt7cW1a9dw9epVZGVlwW63a/Tmfc9ZjnPkN0lTpeMWzry8PO2at7Ozg/X1dU14lPp2405wa2sLExMTmJycfCdJ66T7epaxL/kEkp+yvb2tO3xjFMHYBEhaV6cnZ8p7XVBQALfbjcPDQ41SyGLwvqZEYoxjLI087mhHkHJBGTsS5t/c3FTjLBmjkpMif54+rnJycuDxeJCbm6tjKhwOq/AwtsGVuUnmoONyPOQYBwCi0ShCoZAeaZnNZuTl5amttdjqSiKuvPPGkjljy+GMjAzE43HMzc1hYGDgR71vmZmZyM7OTkne3Nvb07FrHFuSqC1OqSIWjLt7OfKRIyJjN0sKgJ9P5l/Tj0kvPRJbSjmnl52HdMUy9nOXP5P+59KWV14qr9ermeZyLGBcSC0WC5xOJzweDxwOh04ANpsNLpcLOTk5KbWq8qJJ73XpFS7nr2fpZW1sRJSRkQGv14v6+npUVlZqxy5jmM9qtWomr1yjRASke98333yDa9eu4eDgAF1dXfiv//ovPHr0CJ2dnejr68PS0hJyc3PR2tqKxsZGPSOUc2QJl25tbWFubi6ll4H4eX/yySf4+7//e3z55ZcoKytDJBJBV1cXXr58qcmPOzs7CIVCSCaT2iBFqhGMOw4JDefm5mp3MDnblgYtYoZycHCgNcTGReg4ASmmN8ZIizw3SZIUoSYGRE6nU8vFZFI1Lj5Gq2Fph5xurnLSc5bSs8zMTG1OIx4F4kRpMplQVlaG8+fPw+fzabOjSCSiIuzg4ACbm5vY2trC4eGhelLU1NRom1fjvRV7VQlPSxTizBOMQfBKYyJprLS3t4fd3V3s7Oyo4UtlZSV8Ph9sNpuePYvDYnNzMxoaGuB0OlOaS53F1EvCzcajHQnDH+dOJ0KqsLBQKymWl5c1KU/KVeX5ORwO9eQXoyvJe/F4PFpKazabNXdISkHluRibJ7lcLm3rLBEvsR1uampCW1ub9gyJRqOIRqP6jEV4iSGWLPrGlsvybCWKsb29jY2NDU0erqysRF1dHYqKio593+x2O/Lz81VoGiMgkkciYrqwsFAjArJpsVgsqK+vx8WLF+Hz+fS4QH6HHHXIpsJisWgjt/X19ZScIvILjwDIAieDThpkiKGGdDSrqalJcYpLn6hkUpIQ09LSEoLBIFpbW5Gfn4/29nasra3h2bNnmJ+f1wnZarVqoll2djYCgQDGxsawv7+PpqYm1NbWahRCwo0HBwcwm82oqqrCJ598gvPnz6txjpyTyu85LuQMQDNiZ2dn0dDQgKKiIty6dQuhUAg5OTkpJUSyQ5ezOenhfXBwALfbjZs3b+Lv/u7vcOvWLWRlZeHVq1e4d+8eOjo6NPw9ODgIv9+P0tJS1NbW4uLFi+ju7kY4HIbZbEZJSQmKioq0Vevh4SHcbjeqqqo04a+5uRm3b99WA5FYLIauri7cv39fDX5kpy4e6TU1NWhqasLXX3+tpWgbGxu6EOfk5GjDk7W1NYyOjmpylfQPd7lc2N7efsfN76QGNjKJWa1WXVRDoRDC4bAmbJlMJqyvryMWi8Hj8aC2thYHBwcIBoMIhUL6W7Kzs1FVVYU7d+6gqalJy7IkMfOk8LqIEylVW11d1TLOq1evYnZ2FiaTCaurq7BarSgsLMSVK1fw1VdfoaGhQQWeWAPLBLy6uoqZmRmsra2hsLAQly5dwm9+8xtkZ2djYmJCPe6zsrK0lFb6uY+MjGiC1vuiAXL8JDv0wsJCnD9/Xp0m5Ux5ZWUFGxsbcLvdaGpqwq1btxAOhzE9Pa2+BK2trfjiiy+0i2Y8HkcymTzx2O045FjQaAZlFADGZLLMzEwUFBSgqKhIK0GMpj3JZFKNenZ3d1Wg3L59W331ZQG7cOECfvOb36CtrU1FmXG3Dfyva+XW1ha2trZQUlKCsrIyXL58GXNzcxgfH8f+/j4cDgfq6upw+/Zt3LlzB8XFxZqMnF4Hb4xS5ebm6jsk76bX69WOenI0Oj09jcXFRW2A9Dd/8zc4ODjAwMCAnvObTCatMHC5XBo9knu4t7eHaDSqUZX8/HxcunRJ/ThisZgKjFu3bqknidwDOcoTsVNaWoqSkhJkZWVhfX1dy3fT83AIcwB0d+/1elFTU4Pi4mJV59evX0dxcTFisdg7pW0HBwcail1aWtIdr9/vx5s3b9Da2oqWlha0tbVpg5Dp6WlNbpNzrMrKSmxsbODu3buYn5+H2WzW9pX7+/sIBAIIBALaFlS6jX300Udobm7G4eEhRkdH0d/fj5WVlWNDicawdTKZxMzMDF6/fo2GhgbtMma329HS0oK5uTm1R7Xb7XpP1tbWcPfuXQSDQdhsNty6dQv/+I//iC+//BJOpxNv3rzRBjZS0xyLxeD3+zEyMoJLly7B7Xbj0qVLaGlpwfT0tHZX83g8KX3Ks7Ozsbe3p654tbW1qKyshM1mw/LyMl68eIHvvvsOz58/V2MZaYQk1RSlpaUoLy/H119/jbKyMl3g9/b2NHmqtrYWOTk56Ozs1AQqs9mM0tJSnDt3Tj3fxYXuJJ/wo6Mj7c2+s7OD3Nxc7QRZWVmJUCikz21nZwfd3d2Yn59XP3ibzYbh4WEsLi7q+MjNzUVtba1WfEgviIGBASwvLx+b+W/83/F4HNPT0/D7/bhw4QKcTieuXr2KzMxM1NTUYHl5Gbm5uaiurkZLSwtqamq07l5C0+KbL7kir1+/RktLC7xeL2pra/G73/0O1dXV8Pv9en9EtJWVleHo6AjPnz/XzPTjJt7035FIJNQdrq2tDUVFRfjiiy/UmOrp06dYXl7G6OgoFhYWkJ+fj+rqanz11Vdwu92YmJjA0dERSktLcf78eTQ1NWlZm8ViQV5eHvLy8tTN7rg5wRiaLi4uRnV1NVwuF5LJJFZXV7G8vIydnZ2ULHtZNMvKyuDz+VKyz41Ha1L1s7a2piY6+/v7KCkpwezsLMxmM6qrq9Ha2ora2lpNZJMQvSRiSph+bm4OCwsLqK+vR0lJCT7//HM4nU4tuSwqKkJjYyPq6+t1Zy4LstPpTLHADofDGuXJz8/HzZs3YTabtYuhz+dDRUUF5ubmcO/ePfT19eHNmzfo6+tTIf/ll1+ipKREvUmkh0RhYSFqa2thsVjQ19eHWCyG2dlZHB4e6qYkGAzi0qVLcDqd+Pjjj5GVlYXm5mZEo1G43W7U19ejpaUFZWVlWnmQm5sLp9Opxygul0vdLCUR25iwyfA/BcA7E6bRWEJCU1arVUPWxw0YsfI9PDxEf38//H4/Xrx4gcXFRbx8+RIVFRXaN72pqQmVlZWaoCNNSeSFHh4e1mxaj8eDmpoaXLlyBTk5OWoiIiFbm80Gp9OpBhhDQ0PaYfCkc8n0SXZxcREdHR163FFeXq7+/VtbW3o8IMLIZDLh7du3es5dXl6Ov/3bv8WtW7fgcDgwNDSE7777TrvXGc8M5+fntcSutbVVW/52d3dr4pw0SXG5XLh58yYuXbqkIXDxS9jc3MTw8LB2K+zt7cX8/LyWTMoiPDw8jP/5n/+Bw+HQBeTOnTv46KOPsLW1hWQyqeF6j8eDzc1NjI+P6wQi5XwiSiRZ6rQM4qOjI82jGB8f17Dx559/jgsXLmg0qaCgAMFgUMuRpBWx7HLlaEaOh1wul55jDg4O4uHDh+jv7z+xgU36+JSOf1VVVbh69So8Hg8+/fRTnD9/Xsuv8vLycHBwgI2NDcTjcbXAlrEp42ZjYwM9PT3ar6GxsRFVVVUoKSlBe3u7NnyR0kvxHhgcHNRjkbOwu7urjpJVVVWoqalRMba+vq4tlHt7e3H+/HktHzt//jwqKys1uU8W+UQigUAgoBUd4sFhsVg0RP6+vCCpSJBksvX1df2txmdwXP2/WGYLS0tL6OnpQXNzM2w2G7xeL27cuIHa2lq1x3Y6ndpdcmtrS7tTijeHCI9EIoHR0VF0dXXB5/PB5/OhubkZlZWVCIfDWuIrrXKnp6e1DNE4/2RkZCCRSGBmZgbDw8Oor6+Hz+fD+fPnUVFRgc3NTSQSCX1XX758ia6uLuzu7mJkZASPHz+Gx+PBlStX4PV68dlnn+HSpUuIRqPazEhyTCSHQpqXSQRgdnYWPT09qKmpwcWLF1FWVoavvvoK165dQyKRgN1uh81mU4G4urqKiooKWK1WbTSVkZEBj8cDr9eLnJwcJJPJlAgq+TCYAPx/fy1HANIcp7q6Go2NjXA4HBpSlzIdOWcy/kdeinA4rAvT+Pg4kskktra2EIlEEI/HdYES9zqHw4GcnBxkZmZiY2MDU1NT2r50fn5es5bFTEUm6fz8fLhcLthsNn2ZOzs7cffuXTx+/BhTU1Mp5h/HJTbJf5LJJDY3N3XSlyiInN1KqZIkC42Pj+PFixfo6enR7n5Xr16F1WrF1NQUHjx4gG+//Rajo6N6DXJvd3d3YbVa4XQ69dqnpqYQDAZRUlKCTz/9FPX19cjOztbIg2SvS8320NAQOjo68Ic//AHff/89ent7sbKykhIONe58NzY29GxShIw0DMrNzdWs5cXFRbx58wY//PADBgYGEIlE1PLW5/OpO2NHR4fe3/QjAPl+CS3L9Us1Qk5ODhwOB7KzsxGNRlMsccWcyGw2IysrC06nUzPgzWYz4vE4JicnNeLx8OFDTE9Pp/SvP+4oQP5c8gBktyqJVrJrkqOAFy9e4OnTp7oji0ajGBsbw8DAABYXF/WMVvqzS8mknLnKb3Q4HHo2LFGmrq4ujI2N6bN93zt5dHSEeDyOaDSqxyFmsxnhcBiDg4OaRCrlc/L+SuMhGbvb29vo6+vDkydP8PbtWyQSCe0I19fXh0AgkOJLcFzCYk5OjvowAMDIyAiePXumfRSMEQBZfBoaGlBZWYl4PI5Xr17h2bNnCAQC+syk2ZfkAUhnTbmHVqsV4XAYvb29ePDgAaampnB0dIRYLKZmXLOzsypeYrGY7m6lDFlyhCRJbnBwULtLihhZWVlBf38/RkZGsLW1lXIsYDKZNBFTIg8SDVpZWUFvby+6u7sRDAZ1LpTnJRUH8ixkcZaywr6+Pm3VLJURImakCZfkylitVjWYkoZjT58+xfPnz7UbZywWw9DQEN6+fYtwOIyKigo0NDTA5XJhdnYWHR0dePXqFdbW1t6pxiG/4AiAMZNYzmDv37+PgYEBLRc7becilqOiXoeHh3WBiEQi6O3txfr6OgYGBlBXV4eSkhLdlciZl5SXTU5OYnJyUl/E//7v/8b09DQqKyv13EySoOLxOFZXVzE7O4vJyUn4/f53FO5JpYrGCTgSiaC7uxtra2sYHh5Wm1fZcUt9dSgUQjAYxPj4OGZnZ7VF6OPHj3VXNDw8rKU/RlMUUfd+vx93797F2NgYTCYTJicnsbe3pyYmFosFoVAIPT09mJ2d1SiJ8R7Nzc3peapxIU7/vclkEhMTE9jc3MTU1JQu5h6PB1arVRsJid9AIBDA5OSkHp/s7u5icHBQF4CpqSn4/f5jTWyM91S+9969exqSlUxl45n82NgYRkdHsbGxgWAwiEAggOrqahQWFqpZkkxs0hNhYmICU1NTWFpaeu9zTj9Pn56eRjKZxMLCAhobG7W5kezqZ2Zm1GOioKAAAwMDsNlsmJmZwcLCQorTXTwex+joKDY3NzE5OYm6ujrNo7BYLCoSJPQ9PT2N6elpDYGfdr3GeynOiOI3UFtbi/39ffT19akpVzQaRVdXFyKRCAYHB1FVVYX8/HyYzWY1B+rv79ey2KGhIVRUVGBtbQ1jY2MnmgAZ/7csOvfu3YPL5dJFU0RzevlhLBZDX18f9vb2YLFY1Csh/ZlJefDa2hrevn0Ln88Ht9uNzMxMDY0PDg5ifHwcLpcLY2NjcDgcWFxcRCAQSPm8WCymeTDj4+NqDpadna33YXh4GH6/H/F4HDU1NXj9+rXu3sVPQu6ptBqfmJiAz+eD0+lEVlaWJiEuLCxgaGgIfr9fyz8DgYBGWkQASWtteZ7yvs3MzGBychILCwspInp3d1c/MxgMoqGhASUlJbDZbNjb28P6+jr8fj8GBgYQDodRVFSkkdOJiQntoLi+vo7nz59jdnYWsVgMw8PD6mbJ8P8H2jwD+Ku6i8ZzT7PZnCIOThswxp2WZOEb/1zCdvn5+XA4HJplv7+/r/Wx0WhUDVqMyYXGUL/sEo+OjrC7u6uRCdkFnbQbfN/Rh1yjw+GA2+1OCaVJxrKUYcnZoNwnmfB3dnYQj8d1t22soTbWC4stqEQFCgsL8Q//8A/453/+Z/h8PvT29uLf/u3f0NnZqSWTyWQS8XhcjyWM9+ckT4b0JjDiemhsqyzXHIvFsLW1lbK4S7ay7Hjkfr8vXKzqOCsLLpdLHdGkSkOqLzY2NjShS876Zackz1nu0fb2Nra2trC5ufmTn7MsrDk5OXC73SomRQhFIhFEIhEkk0mt+MjMzEzZkR3Xsc9ut8PpdMLpdMJut2tvBxkzUg3zU0Kvxut2OBwaEt/Y2EgxMxLPBrnf8sx2dnb06Ez6vksESu6rMcnxxFDn/x/dkLC70R8jfTcpkSZjxYLcC1koZewavfmlNM9ut+Pw8FANlSSfxGKxaGRFrt34eXINMu4KCgrUaGh3dxebm5sIh8OacOdwOLRUVYy/0stTbTabZuuLq6b8dpl3JKJy3PvmdDq1gknmLOOYEI+A0+YjqToybpgikYgm8kqTofSxKt4IYk4kHgRnaUFNfqEC4E+BsflKegTiLEcV6e1+P7SSNR4RnHaN6X//Y++BlCxduHAB//Iv/4J/+qd/gs1mw3/+53/iX//1X/Hy5cuUbPsPYddpLCv7Y97D9z23037Ln+o5pzcB+rn397h7+8ewWH2f8PnQv+vPNTf83Gv/0J9l7Cty1uY5xrbVxkjJjxnL6Z/Bxj08AviLjyIYB6i8iDJwTzNJMU6exy1UJxnIGF/On/JyGHfsp31G+jWdFlE47d4YHRMdDoeGjqXvgNFq2Ph56cLkfZOa8f/f2O/7tGjIhwgPpt/P07pGpoed/1jP+Syi86TPP8kk56yLfXqW/M+57uOiEO9b6NLHwV/afHGWaz/LMzeOu597H4zRtdM+77j38yxz1mnvW/rnHPcZP3fOIxQA71WcP2Vgpf8bY2vek2pPjedSx3WJ+zH/7qdgbGBy3MKU/lKnv4THTdDv200cHBxo+Vl1dTXMZrOeG29vb6uzWXq7zh8zgRvFVHrk5bjIgvG/H3fPz/rdxjDvSQt9+v2S+5K+2B5373/OuDTu1I+7V8b7dZogMo6Zs173Tx2bJ0XOjP/9pGecfs9OckA8yy74x4z1s4rVs1y70V/gtO8/6V79lPtw2mcd93nHjefjxv5xv+ukvz8pGpn+vekRguP+nEKBAuDME85Zzv1/ygL7Y3ebP/Xf/VTSF8CziJufen/FpKWmpgY+nw/A/yajra6upvQdf19U4sfe/5Mmxvfd+w/1nSd95nGVDGe5zg/xjI+b/M/6fX+O6z7r/T6tX8eH/v6fM37Oeu1nuYYPdR+O24j8mHuYbrBkFDtn+fc/5v057Z0iFAA/exf/l/L5f0oF+6f6rkgkgoGBAdjtdrx+/RqTk5PveHV/yGv5c+wCfsxC8H9xnP+l7az+L+/0/lLH+oeasz5EVJVQAJC/gsltc3MTnZ2dWFxcRGZmJhYWFjAxMaHNZvjiE0LIXyasAiA/C2mZLD4L0gTltG55hBBCKAAIIYQQ8meARwDkZ5OeRW40nCGEEEIBQP5K+b9m1kIIIYRHAIQQQsgvkkzeAkIIIYQCgBBCCCEUAIQQQgihACCEEEIIBQAhhBBCKAAIIYQQQgFACCGEEAoAQgghhFAAEEIIIYQCgBBCCCEUAIQQQgihACCEEEIIBQAhhBBCKAAIIYQQQgFACCGEEAoAQgghhFAAEEIIIYQCgBBCCKEAIIQQQggFACGEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIIRQAhBBCCKEAIIQQQggFACGEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIIRQAhBBCCKEAIIQQQigACCGEEEIBQAghhBAKAEIIIYRQABBCCCGEAoAQQgghFACEEEIIoQAghBBCCAUAIYQQQigACCGEEEIBQAghhBAKAEIIIYRQABBCCCGEAoAQQgghFACEEEIIoQAghBBCCAUAIYQQQigACCGEEAoAQgghhFAAEEIIIYQCgBBCCCEUAIQQQgihACCEEEIIBQAhhBBCKAAIIYQQQgFACCGEEAoAQgghhFAAEEIIIYQCgBBCCCEUAIQQQgihACCEEEIIBQAhhBBCKAAIIYQQQgFACCGEEAoAQgghhAKAEEIIIRQAhBBCCKEAIIQQQggFACGEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIIRQAhBBCCKEAIIQQQggFACGEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIoQDgLSCEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIIRQAhBBCCKEAIIQQQggFACGEEEIoAAghhBBCAUAIIYQQCgBCCCGEUAAQQgghhAKAEEIIIRQAhBBCCKEAIIQQQggFACGEEEIoAAghhBAKAEIIIYRQABBCCCGEAoAQQgghFACEEEIIoQAghBBCCAUAIYQQQigACCGEEEIBQAghhBAKAEIIIYRQABBCCCGEAoAQQgghFACEEEIIoQAghBBCCAUAIYQQQigACCGEEEIBQAghhBAKAEIIIYQCgBBCCCEUAIQQQgihACCEEEIIBQAhhBBCKAAIIYQQQgFACCGEEAoAQgghhFAAEEIIIYQCgBBCCCEUAIQQQgihACCEEELIH4H/B2VRvTjeuygkAAAAAElFTkSuQmCC', 'base64');
const PWA_PNG_512_MASKABLE = Buffer.from('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IiJiDwAREREt1YjiISAiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiImIA4CEgIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiKiz8z/DydalX3cCG2tAAAAAElFTkSuQmCC', 'base64');
app.get('/pwa-icon-192.png', (req, res) => { res.type('image/png').set('Cache-Control','public, max-age=604800').send(PWA_PNG_192); });
app.get('/pwa-icon-512.png', (req, res) => { res.type('image/png').set('Cache-Control','public, max-age=604800').send(PWA_PNG_512); });
app.get('/pwa-icon-512-maskable.png', (req, res) => { res.type('image/png').set('Cache-Control','public, max-age=604800').send(PWA_PNG_512_MASKABLE); });
app.get('/apple-touch-icon.png', (req, res) => { res.type('image/png').send(PWA_PNG_192); });
app.get('/apple-touch-icon-precomposed.png', (req, res) => { res.type('image/png').send(PWA_PNG_192); });

// Service worker : cache uniquement le "shell" et les assets statiques.
// L'API (/api/...) n'est JAMAIS mise en cache (données toujours fraîches).
// La version du cache est liée au démarrage du serveur : chaque redéploiement
// génère une nouvelle version → mise à jour propre et automatique sur tous les appareils.
const SW_VERSION = 'apro-' + Date.now();
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(`
const CACHE='${SW_VERSION}';
const SHELL=['/','/manifest.webmanifest','/pwa-icon-192.png','https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'}))).catch(()=>{})));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting();});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'){return;}
  const url=new URL(req.url);
  // Ne jamais mettre l'API en cache : réseau direct.
  if(url.pathname.startsWith('/api/')){return;}
  // Navigation (HTML) : réseau d'abord, repli sur le cache si hors-ligne.
  if(req.mode==='navigate'){
    e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put('/',cp)).catch(()=>{});return r;}).catch(()=>caches.match('/')));
    return;
  }
  // Autres assets (icônes, CSS CDN) : stale-while-revalidate.
  e.respondWith(caches.match(req).then(cached=>{
    const net=fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});return r;}).catch(()=>cached);
    return cached||net;
  }));
});
// ── PUSH : afficher la notification reçue ──
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(_){d={};}
  const title=d.title||'AppROVISIO';
  const opts={
    body:d.body||'',
    icon:'/pwa-icon-192.png',
    badge:'/pwa-icon-192.png',
    data:{approId:d.approId||null,type:d.type||''},
    tag:d.approId?('appro-'+d.approId):undefined,
    renotify:!!d.approId
  };
  e.waitUntil(self.registration.showNotification(title,opts));
});
// ── Clic sur la notification : ouvrir l'app (et l'appro visée si présente) ──
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const approId=e.notification.data&&e.notification.data.approId;
  const target=approId?('/?appro='+approId):'/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){ if('focus' in c){ c.navigate(target).catch(()=>{}); return c.focus(); } }
    if(clients.openWindow) return clients.openWindow(target);
  }));
});
`);
});

// ── FRONTEND ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
async function initWithRetry(maxTries) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      await initDB();
      return;
    } catch (e) {
      console.error(`Base pas encore prête (tentative ${i}/${maxTries}) : ${e.message}`);
      if (i === maxTries) throw e;
      await new Promise(function (r) { setTimeout(r, 3000); });
    }
  }
}
initWithRetry(15).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AppROVISIO démarré sur le port ${PORT}`);
    console.log(`Code admin de démarrage : ${BOOTSTRAP_ADMIN_CODE}`);
  });
}).catch(err => {
  console.error('Erreur démarrage:', err.message);
  process.exit(1);
});
