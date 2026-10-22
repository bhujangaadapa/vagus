import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DashboardComponent } from './core/components/dashboard/dashboard.component';
import { DeveloperLabComponent } from './core/components/developer-lab/developer-lab.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DashboardComponent, DeveloperLabComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  public readonly activeView = signal<'dashboard' | 'developer-lab'>('dashboard');

  public setView(view: 'dashboard' | 'developer-lab'): void {
    this.activeView.set(view);
  }
}
