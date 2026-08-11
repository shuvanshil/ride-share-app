// Import the core Firebase App SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

// Import the specific Firebase features we need
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD_mNOtbXCYucI--drFUMtp40MIIADSDfU",
  authDomain: "tripura-rideshare.firebaseapp.com",
  projectId: "tripura-rideshare",
  storageBucket: "tripura-rideshare.firebasestorage.app",
  messagingSenderId: "678756320479",
  appId: "1:678756320479:web:3861739b218640bb3fd56a"
};

// Initialize the core Firebase App instance
const app = initializeApp(firebaseConfig);

// Initialize services and export them for use in auth.js, map.js, and app.js
export { app };
export const auth = getAuth(app);

// Modern Firestore initialization with persistent cache
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

console.log("Firebase services initialized successfully.");
