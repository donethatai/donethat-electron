const { initializeApp } = require("firebase/app");
const {
  getAuth,
  createUserWithEmailAndPassword,
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

// Listen to the Sign Up form submission
document.getElementById("signUpForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("signUpEmail").value;
  const password = document.getElementById("signUpPassword").value;

  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      alert("Signed up successfully: " + userCredential.user.email);
      window.location.href = "index.html";
    })
    .catch((error) => {
      alert("Sign up error: " + error.message);
    });
}); 