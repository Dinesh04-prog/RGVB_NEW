us-west1 (Oregon)

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyArkZiqGAUJRqiBKQmYndBWTfpDq-4SWiM",
  authDomain: "nexus-pos-817c3.firebaseapp.com",
  projectId: "nexus-pos-817c3",
  storageBucket: "nexus-pos-817c3.firebasestorage.app",
  messagingSenderId: "77380160715",
  appId: "1:77380160715:web:c6cd94906ee7fcc24b9f4e",
  measurementId: "G-QSGXW4SQLV"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);