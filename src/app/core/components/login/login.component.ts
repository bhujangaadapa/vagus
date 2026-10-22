import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Capacitor } from '@capacitor/core';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
})
export class LoginComponent {
  public readonly authService = inject(AuthService);
  public readonly isNativeApp = Capacitor.isNativePlatform();

  // Mode: 'login' or 'register'
  public readonly activeMode = signal<'login' | 'register'>('login');

  // Form Fields
  public emailInput = '';
  public passwordInput = '';
  
  // Athlete Profile Fields (for Account Creation / Calibration)
  public genderInput: 'male' | 'female' | 'other' = 'male';
  public ageInput: number = 24;
  public weightInput: number = 72;
  public heightInput: number = 178;

  public readonly errorMessage = signal<string | null>(null);
  public readonly isSubmitting = signal<boolean>(false);

  public setMode(mode: 'login' | 'register'): void {
    this.activeMode.set(mode);
    this.errorMessage.set(null);
  }

  public async submitForm(): Promise<void> {
    if (!this.emailInput || !this.passwordInput) {
      this.errorMessage.set('Please enter both email and password.');
      return;
    }

    if (this.passwordInput.length < 6) {
      this.errorMessage.set('Password must be at least 6 characters.');
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set(null);

    try {
      const user = await this.authService.loginWithEmail(this.emailInput.trim(), this.passwordInput);
      if (user) {
        // If registering or setting up profile, save real calibrated demographics immediately
        if (this.activeMode() === 'register') {
          await this.authService.updateDemographics(
            user.uid,
            {
              gender: this.genderInput,
              age: Number(this.ageInput) || 24,
              weightKg: Number(this.weightInput) || 72,
              heightCm: Number(this.heightInput) || 178,
            },
            {
              dailyStepGoal: 10000,
              metricUnits: true,
            }
          );
        }
      } else if (this.authService.authError()) {
        this.errorMessage.set(this.authService.authError());
      }
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  public async loginWithGoogle(): Promise<void> {
    this.errorMessage.set(null);

    if (this.isNativeApp) {
      // In native Android WebView, Google blocks popup windows for OAuth security.
      this.errorMessage.set('Google blocks OAuth popups inside native Android apps. Please sign in with your email and password above.');
      return;
    }

    this.isSubmitting.set(true);
    try {
      await this.authService.loginWithGoogle();
      if (this.authService.authError()) {
        this.errorMessage.set(this.authService.authError());
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
