import { NavLink, Outlet } from 'react-router-dom';
import { Settings, LayoutDashboard, Upload, Clock, BookOpen, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/queue', icon: Upload, label: 'Upload Queue' },
  { to: '/schedule', icon: Clock, label: 'Schedule' },
  { to: '/chat', icon: MessageSquare, label: 'AI Chat' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/setup', icon: BookOpen, label: 'Setup Guide' },
];

export default function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r bg-card flex flex-col">
        <div className="p-6 pb-4">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Video Uploader
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            YouTube · TikTok · Instagram
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                )
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t">
          <p className="text-xs text-muted-foreground">
            Cloud-connected · Local server for uploads
          </p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}