const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged
} = require("firebase/auth");
const firebaseConfig = require("./firebase-config.js");

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

onAuthStateChanged(auth, (user) => {
  const statusEl = document.getElementById("auth-status");
  if (user) {
    statusEl.textContent = `Signed in as ${user.email}`;
  } else {
    statusEl.textContent = "Not signed in.";
  }
});

document.getElementById("signInForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("signInEmail").value;
  const password = document.getElementById("signInPassword").value;

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      alert("Signed in successfully: " + userCredential.user.email);
    })
    .catch((error) => {
      alert("Sign in error: " + error.message);
    });
}); 