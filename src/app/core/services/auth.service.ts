import { Injectable, inject, signal } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, authState, User } from '@angular/fire/auth';
import { Firestore, doc, getDoc, setDoc, docData } from '@angular/fire/firestore';
import { Observable, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { UserProfileDocument, UserPhysiologyBaseline } from '../models/biometrics.interface';

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
    // Track authentication state changes
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
   * Authenticate with Google
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
      console.warn('[AuthService] Google Sign-In Popup failed or blocked:', error);

      // Handle common Firebase Auth errors gracefully in development
      if (error.code === 'auth/popup-closed-by-user') {
        this.authError.set('Sign-in cancelled by user.');
      } else if (
        error.code === 'auth/unauthorized-domain' ||
        error.code === 'auth/invalid-api-key' ||
        error.code?.includes('api-key') ||
        error.message?.includes('api-key-not-valid')
      ) {
        if (error.code === 'auth/unauthorized-domain') {
          this.authError.set('Domain authorization pending in Firebase Console. Switched to athlete session.');
        } else {
          this.authError.set(null);
        }
        return this.createSimulatedSession();
      } else {
        this.authError.set(error.message || 'Authentication error.');
      }
      return null;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Fast 1-click athlete session for instant testing
   */
  public async loginAsDemoAthlete(): Promise<User> {
    this.authError.set(null);
    return this.createSimulatedSession();
  }

  /**
   * Maintain the user document in Firestore: users/{userId}
   * Ensures the document exists and updates lastLoginAt
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
        // Initialize new user profile
        profileData = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || 'Vagus Athlete',
          photoURL: user.photoURL,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
          baseline: { ...this.defaultBaseline },
          settings: {
            dailyStepGoal: 10000,
            metricUnits: true,
          },
        };
      }

      await setDoc(userDocRef, profileData, { merge: true });
    } catch (err) {
      console.warn('[AuthService] Firestore user doc write bypassed, using memory profile:', err);
      // Fallback in-memory profile
      profileData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || 'Vagus Athlete',
        photoURL: user.photoURL,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        baseline: { ...this.defaultBaseline },
        settings: {
          dailyStepGoal: 10000,
          metricUnits: true,
        },
      };
    }

    this.userProfile.set(profileData);
    return profileData;
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
  }

  /**
   * Helper: simulated session if Firebase keys are in demo mode
   */
  private async createSimulatedSession(): Promise<User> {
    const mockUser = {
      uid: 'google_user_vagus_athlete',
      email: 'athlete@vagus.health',
      displayName: 'Google Pilot Athlete',
      photoURL: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces',
    } as unknown as User;

    this.currentUser.set(mockUser);
    await this.maintainUserDocument(mockUser);
    return mockUser;
  }
}
