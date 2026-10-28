import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Thunder Vision",
  description: "Your tmux sessions, in the browser.",
  appleWebApp: {
    capable: true,
    title: "Thunder Vision",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Keep iOS from zooming the page when the terminal's textarea takes focus.
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0f0f1a",
};

/**
 * Brave on iOS injects a wallet shim that throws on every load
 * (`window.ethereum.selectedAddress = undefined`). Not our error: keep it out
 * of Next's dev issues badge, which would otherwise count one per reload.
 * Inline in <head> so it's registered before Next's own error listeners.
 */
const ignoreInjectedErrors = `window.addEventListener("error", function (e) {
  if (/\\bwindow\\.ethereum\\b/.test(e.message)) e.stopImmediatePropagation();
}, true);`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: ignoreInjectedErrors }} />
      </head>
      <body className="flex h-dvh flex-col overflow-hidden">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
        >
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
