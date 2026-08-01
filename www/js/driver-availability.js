import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export async function markCurrentDriverOffline() {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return;

    const profileSnapshot = await getDoc(doc(db, "users", firebaseUser.uid));
    const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
    if (profile?.role !== "driver") return;

    const idToken = await firebaseUser.getIdToken();
    const response = await fetch("/api/rides/driver-availability", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({ status: "offline" })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not mark driver offline.");
    }
}
