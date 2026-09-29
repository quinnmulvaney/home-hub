// Firebase web config for the "Mulvaney Family App" project (see README.md, "Turn on sync").
// These values are safe to publish — access is protected by firestore.rules, not by hiding this.
export const firebaseConfig = {
  apiKey: 'AIzaSyAm1S7Tm_1uT93w-jceURGDvkxWxeSI_hM',
  authDomain: 'mulvaney-family-app.firebaseapp.com',
  projectId: 'mulvaney-family-app',
  storageBucket: 'mulvaney-family-app.firebasestorage.app',
  messagingSenderId: '185124614984',
  appId: '1:185124614984:web:aaf6c404ab0f541976797d',
};

// Web Push key (Firebase console → Project settings → Cloud Messaging → Web Push certificates →
// Generate key pair). Leave empty to use in-app alerts only. Public value, safe to commit.
export const vapidKey = '';
