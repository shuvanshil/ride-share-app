import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { registerSignOutHook } from '../shared/auth.js';

export async function markCurrentDriverOffline() {
    try {
        const firebaseUser = auth.currentUser;
        if (!firebaseUser) return;

        // Try to get cached profile first for speed
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
            body: JSON.stringify({ status: "offline" }),
            // Short timeout for logout operations
            signal: AbortSignal.timeout(3500)
        });

        console.log("Driver marked offline successfully.");
    } catch (error) {
        console.warn("Could not mark driver offline during logout (non-fatal):", error);
    }
}

registerSignOutHook(markCurrentDriverOffline);

