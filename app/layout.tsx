import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "A responsive cycling protocol timer for time-and-power CSV files, with on-the-fly 50 W warmup extensions.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Day 4 Protocol Timer",
    description,
    applicationName: "Day 4 Protocol Timer",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "D4 Timer",
    },
    openGraph: {
      title: "Day 4 Protocol Timer",
      description,
      type: "website",
      url: origin,
      images: [
        {
          url: `${origin}/og.png`,
          width: 1536,
          height: 1024,
          alt: "Day 4 Protocol Timer showing a countdown, current power, and next interval",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Day 4 Protocol Timer",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#07111d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
