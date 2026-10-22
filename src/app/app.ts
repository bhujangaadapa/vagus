import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DashboardComponent } from './core/components/dashboard/dashboard.component';
import { DeveloperLabComponent } from './core/components/developer-lab/developer-lab.component';
import { LoginComponent } from './core/components/login/login.component';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DashboardComponent, DeveloperLabComponent, LoginComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  public readonly authService = inject(AuthService);
  public readonly activeView = signal<'dashboard' | 'developer-lab'>('dashboard');

  public setView(view: 'dashboard' | 'developer-lab'): void {
    this.activeView.set(view);
  }
}
