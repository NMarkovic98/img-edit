/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: [
      'i.redd.it',
      'preview.redd.it',
      'external-preview.redd.it',
      'b.thumbs.redditmedia.com',
      'a.thumbs.redditmedia.com',
      'imgur.com',
      'i.imgur.com',
      'fal.media',
      'v3.fal.media',
      'storage.googleapis.com',
    ],
  },
  // experimental: {
  //   outputFileTracingExcludes: [
  //     "node_modules/.cache/**",
  //     "node_modules/.bin/**",
  //     ".next/cache/**",
  //     ".git/**"
  //   ]
  // }
}

module.exports = nextConfig
