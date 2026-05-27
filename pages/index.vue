<script setup lang="ts">
// `/` is the marketing landing for logged-out visitors. Logged-in users
// are bounced to `/welcome` by `middleware/auth.global.ts` BEFORE this
// page mounts, so we never have to flip layouts at runtime — which is
// what previously caused a flash of the landing chrome and a broken
// app shell after the redirect to /w/{id}.
definePageMeta({ layout: 'landing' })

useHead({
  title: 'NoteForge — penser, sur du papier qui se souvient',
})
</script>

<template>
  <LandingPage />
</template>
