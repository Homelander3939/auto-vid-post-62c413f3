import { NavLink, Outlet } from 'react-router-dom';
import { Settings, LayoutDashboard, Upload, Clock, Wifi, WifiOff } from 'lucide-react';
import { useServerStatus } from '@/hooks/useServerStatus';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/queue', icon: Upload, label: 'Upload Queue' },
  { to: '/schedule', icon: Clock, label: 'Schedule' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function AppLayout() {
  const { data, isError } = useServerStatus();
  const connected = !!data && !isError;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r bg-card flex flex-col">
        <div className="p-6 pb-4">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Video Uploader
          </h1>
          <p className="text-xs text-muted-foreground mt-1">Upload to YouTube · TikTok · Instagram</p>
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
          <div className="flex items-center gap-2 text-xs">
            {connected ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-[hsl(var(--success))]" />
                <span className="text-muted-foreground">Server connected</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-destructive" />
                <span className="text-muted-foreground">Server offline</span>
              </>
            )}
          </div>
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
