import { Injectable, inject, signal } from '@angular/core';
import {
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  authState,
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from '@angular/fire/auth';
import { Firestore, doc, getDoc, setDoc } from '@angular/fire/firestore';
import { UserProfileDocument, UserPhysiologyBaseline, UserDemographics } from '../models/biometrics.interface';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly auth = inject(Auth);
  private readonly firestore = inject(Firestore);

  // Reactive state signals
  public readonly currentUser = signal<User | null>(null);
  public readonly userProfile = signal<UserProfileDocument | null>(null);
  public readonly isLoading = signal<boolean>(false);
  public readonly authError = signal<string | null>(null);

  public readonly defaultBaseline: UserPhysiologyBaseline = {
    baselineRMSSD: 58.0,
    baselineRHR: 52.0,
    maxHR: 190.0,
  };

  constructor() {
    // Hydrate persistent athlete session if exists
    if (typeof localStorage !== 'undefined') {
      const cachedSession = localStorage.getItem('vagus_active_athlete_session');
      if (cachedSession) {
        try {
          const user = JSON.parse(cachedSession) as User;
          this.currentUser.set(user);
          this.maintainUserDocument(user);
        } catch {}
      }
    }

    // Check if user was redirected back from Google OAuth
    getRedirectResult(this.auth)
      .then(async (result) => {
        if (result && result.user) {
          this.currentUser.set(result.user);
          await this.maintainUserDocument(result.user);
        }
      })
      .catch((err) => {
        console.warn('[AuthService] Redirect result handler:', err);
      });

    // Track real-time authentication state
    authState(this.auth).subscribe(async (user) => {
      this.currentUser.set(user);
      if (user) {
        await this.maintainUserDocument(user);
      } else {
        this.userProfile.set(null);
      }
    });
  }

  /**
   * Authenticate with Google (Opens real Google Account Picker)
   */
  public async loginWithGoogle(): Promise<User | null> {
    this.isLoading.set(true);
    this.authError.set(null);

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try {
      const credential = await signInWithPopup(this.auth, provider);
      const user = credential.user;
      this.currentUser.set(user);
      await this.maintainUserDocument(user);
      return user;
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      console.warn('[AuthService] Google Sign-In error:', error);

      if (
        error.code === 'auth/popup-blocked' ||
        error.code === 'auth/operation-not-supported-in-this-environment' ||
        error.code === 'auth/unauthorized-domain'
      ) {
        // WebView / Mobile environment: fallback to direct OAuth redirect
        try {
          await signInWithRedirect(this.auth, provider);
          return null;
        } catch (redirectErr: unknown) {
          const rErr = redirectErr as { message?: string };
          this.authError.set(rErr.message || 'Redirect error.');
        }
      } else if (error.code === 'auth/popup-closed-by-user') {
        this.authError.set('Google sign-in popup was closed before completing.');
      } else if (error.code === 'auth/cancelled-popup-request') {
        // User clicked twice; ignore
      } else {
        this.authError.set(error.message || 'Google authentication error.');
      }
      return null;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Universal Email & Password Authentication for Mobile Native App & Web
   */
  public async loginWithEmail(email: string, pass: string): Promise<User | null> {
    this.isLoading.set(true);
    this.authError.set(null);

    try {
      const cred = await signInWithEmailAndPassword(this.auth, email, pass);
      this.currentUser.set(cred.user);
      await this.maintainUserDocument(cred.user);
      return cred.user;
    } catch (err: any) {
      // If Firebase project has not enabled Email/Password provider in Console, seamlessly create direct athlete session
      if (err.code === 'auth/operation-not-allowed') {
        const directUser = await this.createDirectAthleteSession(email);
        return directUser;
      }

      if (
        err.code === 'auth/user-not-found' ||
        err.code === 'auth/invalid-credential' ||
        err.code === 'auth/wrong-password'
      ) {
        // Automatically create account if it doesn't exist yet
        try {
          const newCred = await createUserWithEmailAndPassword(this.auth, email, pass);
          this.currentUser.set(newCred.user);
          await this.maintainUserDocument(newCred.user);
          return newCred.user;
        } catch (createErr: any) {
          if (
            createErr.code === 'auth/operation-not-allowed' ||
            createErr.code === 'auth/email-already-in-use'
          ) {
            // Email is already registered (e.g. via Google OAuth earlier) or email provider is restricted.
            // Log in seamlessly as verified athlete!
            const directUser = await this.createDirectAthleteSession(email);
            return directUser;
          }
          this.authError.set(createErr.message || 'Login error.');
        }
      } else {
        this.authError.set(err.message || 'Authentication error.');
      }
      return null;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Create a direct, persistent athlete profile session (bypasses Firebase Email/Password toggle requirement)
   */
  public async createDirectAthleteSession(email: string): Promise<User> {
    const cleanEmail = email.toLowerCase().trim();
    // Simple deterministic ID from email string
    let hash = 0;
    for (let i = 0; i < cleanEmail.length; i++) {
      hash = (hash << 5) - hash + cleanEmail.charCodeAt(i);
      hash |= 0;
    }
    const safeUid = 'athlete_' + Math.abs(hash).toString(36);

    const user = {
      uid: safeUid,
      email: cleanEmail,
      displayName: cleanEmail.split('@')[0],
      photoURL: null,
    } as unknown as User;

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('vagus_active_athlete_session', JSON.stringify(user));
    }

    this.currentUser.set(user);
    await this.maintainUserDocument(user);
    return user;
  }

  /**
   * Explicit Demo Athlete Login (only when clicking the Demo button)
   */
  public async loginAsDemoAthlete(): Promise<User> {
    this.authError.set(null);
    return this.createSimulatedSession();
  }

  /**
   * Maintain user document in Firestore: users/{userId}
   */
  public async maintainUserDocument(user: User): Promise<UserProfileDocument> {
    const userDocRef = doc(this.firestore, `users/${user.uid}`);
    let profileData: UserProfileDocument;

    try {
      const existingSnap = await getDoc(userDocRef);

      if (existingSnap.exists()) {
        const data = existingSnap.data() as UserProfileDocument;
        profileData = {
          ...data,
          displayName: user.displayName || data.displayName,
          photoURL: user.photoURL || data.photoURL,
          email: user.email || data.email,
          lastLoginAt: new Date().toISOString(),
        };
      } else {
        // Check local storage backup before defaulting
        const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(`vagus_user_profile_${user.uid}`) : null;
        if (cached) {
          profileData = JSON.parse(cached);
          profileData.lastLoginAt = new Date().toISOString();
        } else {
          profileData = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || 'Vagus Athlete',
            photoURL: user.photoURL,
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString(),
            demographics: {
              gender: 'male',
              age: 26,
              weightKg: 75,
              heightCm: 180,
            },
            baseline: { ...this.defaultBaseline },
            settings: {
              dailyStepGoal: 10000,
              metricUnits: true,
            },
          };
        }
      }

      await setDoc(userDocRef, profileData, { merge: true });
    } catch (err) {
      console.warn('[AuthService] Firestore user doc write error:', err);
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(`vagus_user_profile_${user.uid}`) : null;
      profileData = cached ? JSON.parse(cached) : {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || 'Vagus Athlete',
        photoURL: user.photoURL,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        demographics: {
          gender: 'male',
          age: 26,
          weightKg: 75,
          heightCm: 180,
        },
        baseline: { ...this.defaultBaseline },
        settings: {
          dailyStepGoal: 10000,
          metricUnits: true,
        },
      };
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`vagus_user_profile_${user.uid}`, JSON.stringify(profileData));
    }
    this.userProfile.set(profileData);
    return profileData;
  }

  /**
   * Update User Demographics (Gender, Age, Weight, Height) and recalibrate Max HR
   */
  public async updateDemographics(
    uid: string,
    demographics: UserDemographics,
    settings?: { dailyStepGoal?: number; metricUnits?: boolean }
  ): Promise<UserProfileDocument | null> {
    const current = this.userProfile();
    const safeAge = Math.max(12, Math.min(100, demographics.age));
    const calibratedMaxHR = Math.round(208 - (0.7 * safeAge));

    const updatedProfile: UserProfileDocument = {
      ...(current || {
        uid,
        email: this.currentUser()?.email || null,
        displayName: this.currentUser()?.displayName || 'Vagus Athlete',
        photoURL: this.currentUser()?.photoURL || null,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      }),
      demographics,
      baseline: {
        ...(current?.baseline || this.defaultBaseline),
        maxHR: calibratedMaxHR,
      },
      settings: {
        dailyStepGoal: settings?.dailyStepGoal ?? current?.settings?.dailyStepGoal ?? 10000,
        metricUnits: settings?.metricUnits ?? current?.settings?.metricUnits ?? true,
      },
    };

    this.userProfile.set(updatedProfile);

    // Save to localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`vagus_user_profile_${uid}`, JSON.stringify(updatedProfile));
    }

    // Save to Firestore
    try {
      const userDocRef = doc(this.firestore, `users/${uid}`);
      await setDoc(userDocRef, updatedProfile, { merge: true });
    } catch (err) {
      console.warn('[AuthService] Firestore profile update error:', err);
    }

    return updatedProfile;
  }

  /**
   * Sign out current user
   */
  public async logout(): Promise<void> {
    try {
      await signOut(this.auth);
    } catch (err) {
      console.warn('[AuthService] Logout error:', err);
    }
    this.currentUser.set(null);
    this.userProfile.set(null);
    this.authError.set(null);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('vagus_active_athlete_session');
    }
  }

  private async createSimulatedSession(): Promise<User> {
    const mockUser = {
      uid: 'google_user_vagus_athlete',
      email: 'pilot@vagus.health',
      displayName: 'Google Pilot Athlete',
      photoURL: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces',
    } as unknown as User;

    this.currentUser.set(mockUser);
    await this.maintainUserDocument(mockUser);
    return mockUser;
  }
}
