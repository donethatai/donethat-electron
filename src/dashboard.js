const { initializeApp } = require("firebase/app");
const { getAuth, signOut, onAuthStateChanged } = require("firebase/auth");
const firebaseConfig = require("../firebase-config.js");

// Initialize Firebase app and get Auth instance
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// If no user is signed in, redirect to the sign in page (e.g., index.html)
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
  }
});

// Add click event listener to the logout link to sign out the user
document.getElementById("logoutLink").addEventListener("click", (e) => {
  e.preventDefault();
  signOut(auth)
    .then(() => {
      window.location.href = "index.html";
    })
    .catch((error) => {
      console.error("Error signing out:", error);
    });
}); 