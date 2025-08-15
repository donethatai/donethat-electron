const { initializeApp } = require("firebase/app");
const { getAuth } = require("firebase/auth");
const { getFunctions } = require("firebase/functions");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const functions = getFunctions(firebaseApp, "europe-west1");

module.exports = { auth, firebaseApp, functions }; 