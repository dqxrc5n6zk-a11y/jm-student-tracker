import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import { getStorage } from "firebase/storage";

function readEnvValue(key) {
  return String(import.meta.env[key] || "").trim();
}

const firebaseConfig = {
  apiKey: readEnvValue("VITE_FIREBASE_API_KEY"),
  authDomain: readEnvValue("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: readEnvValue("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: readEnvValue("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: readEnvValue("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: readEnvValue("VITE_FIREBASE_APP_ID"),
};

function hasRequiredFirebaseConfig() {
  const values = [
    firebaseConfig.apiKey,
    firebaseConfig.authDomain,
    firebaseConfig.projectId,
    firebaseConfig.storageBucket,
    firebaseConfig.appId,
  ].map((value) => String(value || "").trim());

  const containsPlaceholder = values.some((value) =>
    /^your[_-]/i.test(value) ||
    value.includes("your_project") ||
    value.includes("your_api_key")
  );

  return Boolean(
    !containsPlaceholder &&
      firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.storageBucket &&
      firebaseConfig.appId
  );
}

let firebaseAppInstance = null;
let firebaseStorageInstance = null;
let firebaseFirestoreInstance = null;
let firebaseAuthInstance = null;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        reject(new Error(message));
      }, ms);
    }),
  ]);
}

export function isFirebaseConfigured() {
  return hasRequiredFirebaseConfig();
}

export function getFirebaseStorageInstance() {
  if (!hasRequiredFirebaseConfig()) {
    return null;
  }

  if (!firebaseAppInstance) {
    firebaseAppInstance = initializeApp(firebaseConfig);
    firebaseStorageInstance = getStorage(firebaseAppInstance);
    firebaseAuthInstance = null;
  }

  return firebaseStorageInstance;
}

export function getFirebaseFirestoreInstance() {
  if (!hasRequiredFirebaseConfig()) {
    return null;
  }

  if (!firebaseAppInstance) {
    firebaseAppInstance = initializeApp(firebaseConfig);
    firebaseStorageInstance = getStorage(firebaseAppInstance);
    firebaseAuthInstance = null;
  }

  if (!firebaseFirestoreInstance) {
    firebaseFirestoreInstance = getFirestore(firebaseAppInstance);
  }

  return firebaseFirestoreInstance;
}

export function getFirebaseAuthInstance() {
  if (!hasRequiredFirebaseConfig()) {
    return null;
  }

  if (!firebaseAppInstance) {
    firebaseAppInstance = initializeApp(firebaseConfig);
    firebaseStorageInstance = getStorage(firebaseAppInstance);
  }

  if (!firebaseAuthInstance) {
    try {
      firebaseAuthInstance = initializeAuth(firebaseAppInstance, {
        persistence: [
          indexedDBLocalPersistence,
          browserLocalPersistence,
          inMemoryPersistence,
        ],
      });
    } catch (error) {
      // Auth may already be initialized elsewhere; fall back to the existing instance.
      firebaseAuthInstance = getAuth(firebaseAppInstance);
      console.warn("Firebase auth initialization fallback:", error);
    }
  }

  return firebaseAuthInstance;
}

export function subscribeToAuthChanges(callback) {
  const auth = getFirebaseAuthInstance();
  if (!auth) {
    return () => {};
  }

  return onAuthStateChanged(auth, callback);
}

export async function signInWithEmailPassword(email, password) {
  const auth = getFirebaseAuthInstance();
  if (!auth) {
    throw new Error("Firebase Auth is not configured.");
  }

  return withTimeout(
    signInWithEmailAndPassword(auth, String(email || "").trim(), String(password || "")),
    12000,
    "Sign-in timed out. Please try again."
  );
}

export async function registerWithEmailPassword({
  email,
  password,
  displayName = "",
  role = "student",
  shooterId = "",
} = {}) {
  const auth = getFirebaseAuthInstance();
  const firestore = getFirebaseFirestoreInstance();

  if (!auth || !firestore) {
    throw new Error("Firebase Auth is not configured.");
  }

  const credentials = await withTimeout(
    createUserWithEmailAndPassword(
      auth,
      String(email || "").trim(),
      String(password || "")
    ),
    12000,
    "Account creation timed out. Please try again."
  );

  const normalizedDisplayName = String(displayName || "").trim();
  const normalizedRole = String(role || "student").trim().toLowerCase() || "student";

  if (normalizedDisplayName) {
    try {
      await withTimeout(
        updateProfile(credentials.user, {
          displayName: normalizedDisplayName,
        }),
        8000,
        "Profile update timed out."
      );
    } catch (error) {
      console.warn("User profile display name update warning:", error);
    }
  }

  try {
    await withTimeout(
      ensureUserProfileRecord({
        uid: credentials.user.uid,
        email: credentials.user.email || email,
        displayName: normalizedDisplayName || credentials.user.displayName || "",
        role: normalizedRole,
        shooterId,
      }),
      8000,
      "User profile save timed out."
    );
  } catch (error) {
    console.warn("User profile record creation warning:", error);
  }

  return credentials;
}

export async function createManagedUserAccount({
  email,
  password,
  displayName = "",
  role = "student",
  shooterId = "",
} = {}) {
  if (!hasRequiredFirebaseConfig()) {
    throw new Error("Firebase Auth is not configured.");
  }

  const normalizedEmail = String(email || "").trim();
  const normalizedPassword = String(password || "");
  const normalizedDisplayName = String(displayName || "").trim();
  const normalizedRole = String(role || "student").trim().toLowerCase() || "student";
  const normalizedShooterId = String(shooterId || "").trim();

  const secondaryAppName = `managed-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const secondaryApp = initializeApp(firebaseConfig, secondaryAppName);
  let secondaryAuth = null;

  try {
    secondaryAuth = initializeAuth(secondaryApp, {
      persistence: [inMemoryPersistence],
    });

    const credentials = await withTimeout(
      createUserWithEmailAndPassword(
        secondaryAuth,
        normalizedEmail,
        normalizedPassword
      ),
      12000,
      "Account creation timed out. Please try again."
    );

    if (normalizedDisplayName) {
      try {
        await withTimeout(
          updateProfile(credentials.user, {
            displayName: normalizedDisplayName,
          }),
          8000,
          "Profile update timed out."
        );
      } catch (error) {
        console.warn("Managed user display name update warning:", error);
      }
    }

    const savedProfile = await withTimeout(
      ensureUserProfileRecord({
        uid: credentials.user.uid,
        email: credentials.user.email || normalizedEmail,
        displayName: normalizedDisplayName || credentials.user.displayName || "",
        role: normalizedRole,
        shooterId: normalizedShooterId,
      }),
      8000,
      "User profile save timed out."
    );

    return {
      credentials,
      profile: savedProfile,
    };
  } finally {
    try {
      if (secondaryAuth?.currentUser) {
        await signOut(secondaryAuth);
      }
    } catch (error) {
      console.warn("Managed user secondary auth sign-out warning:", error);
    }

    try {
      await deleteApp(secondaryApp);
    } catch (error) {
      console.warn("Managed user secondary app cleanup warning:", error);
    }
  }
}

export async function signOutCurrentUser() {
  const auth = getFirebaseAuthInstance();
  if (!auth) return;
  await signOut(auth);
}

export async function getUserProfile(uid) {
  const firestore = getFirebaseFirestoreInstance();
  const normalizedUid = String(uid || "").trim();

  if (!firestore || !normalizedUid) {
    return null;
  }

  const snapshot = await getDoc(doc(firestore, "users", normalizedUid));
  if (!snapshot.exists()) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

export async function ensureUserProfileRecord({
  uid,
  email = "",
  displayName = "",
  role = "student",
  shooterId = "",
} = {}) {
  const firestore = getFirebaseFirestoreInstance();
  const normalizedUid = String(uid || "").trim();

  if (!firestore || !normalizedUid) {
    throw new Error("Missing user id for profile creation.");
  }

  const normalizedRole = String(role || "student").trim().toLowerCase() || "student";
  const profileRef = doc(firestore, "users", normalizedUid);

  await setDoc(
    profileRef,
    {
      email: String(email || "").trim(),
      displayName: String(displayName || "").trim(),
      role: normalizedRole,
      shooterId: String(shooterId || "").trim(),
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );

  return getUserProfile(normalizedUid);
}

export async function listUserProfiles() {
  const firestore = getFirebaseFirestoreInstance();

  if (!firestore) {
    return [];
  }

  const snapshot = await getDocs(collection(firestore, "users"));

  return snapshot.docs
    .map((profileDoc) => ({
      id: profileDoc.id,
      ...profileDoc.data(),
    }))
    .sort((a, b) => {
      const aName = String(a.displayName || a.email || a.id || "").trim().toLowerCase();
      const bName = String(b.displayName || b.email || b.id || "").trim().toLowerCase();
      return aName.localeCompare(bName);
    });
}

export async function updateUserProfileRecord(uid, updates = {}) {
  const firestore = getFirebaseFirestoreInstance();
  const normalizedUid = String(uid || "").trim();

  if (!firestore || !normalizedUid) {
    throw new Error("Missing user id for profile update.");
  }

  const nextPayload = {
    updatedAt: serverTimestamp(),
  };

  if (Object.prototype.hasOwnProperty.call(updates, "displayName")) {
    nextPayload.displayName = String(updates.displayName || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(updates, "email")) {
    nextPayload.email = String(updates.email || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(updates, "role")) {
    nextPayload.role = String(updates.role || "").trim().toLowerCase() || "student";
  }

  if (Object.prototype.hasOwnProperty.call(updates, "shooterId")) {
    nextPayload.shooterId = String(updates.shooterId || "").trim();
  }

  await setDoc(doc(firestore, "users", normalizedUid), nextPayload, { merge: true });

  return getUserProfile(normalizedUid);
}
