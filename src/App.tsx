import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import UploadQueue from "@/pages/UploadQueue";
import Schedule from "@/pages/Schedule";
import SettingsPage from "@/pages/SettingsPage";
import SetupGuide from "@/pages/SetupGuide";
import AIChat from "@/pages/AIChat";
import BrowserSessions from "@/pages/BrowserSessions";
import SocialPosts from "@/pages/SocialPosts";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/queue" element={<UploadQueue />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/chat" element={<AIChat />} />
            <Route path="/browser" element={<BrowserSessions />} />
            <Route path="/social" element={<SocialPosts />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/setup" element={<SetupGuide />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;