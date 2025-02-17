const { initializeApp } = require("firebase/app");
const {
  getAuth,
  sendPasswordResetEmail,
  onAuthStateChanged
} = require("firebase/auth");
const firebaseConfig = require("./firebase-config.js");

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Redirect if already signed in
onAuthStateChanged(auth, (user) => {
  if (user) {
    alert(`Already signed in as ${user.email}. Redirecting to home.`);
    window.location.href = "index.html";
  }
});

// Listen to the Password Reset form submission
document.getElementById("resetForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("resetEmail").value;

  sendPasswordResetEmail(auth, email)
    .then(() => {
      alert("Password reset email sent!");
      window.location.href = "index.html";
    })
    .catch((error) => {
      alert("Password reset error: " + error.message);
    });
}); 