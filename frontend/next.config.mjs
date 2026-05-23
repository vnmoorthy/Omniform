/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle for a slim Cloud Run image.
  output: "standalone",
};

export default nextConfig;
