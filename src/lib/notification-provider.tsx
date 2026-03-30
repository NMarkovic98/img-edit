'use client'

import { useEffect, useRef, useCallback } from 'react'

const REDDIT_USERNAME = 'nmarkovic98'
const SUBREDDITS = ['PhotoshopRequest', 'PhotoshopRequests', 'estoration', 'editmyphoto']
const FETCH_INTERVAL = 30000 // 30 seconds
const REPLY_CHECK_INTERVAL = 60000 // 60 seconds

// ─── Audio: Generate a WAV chime as base64 data URL ──────────────────

function generateChimeWav(freq = 880, durationSec = 0.5, volume = 0.7): string {
  const sampleRate = 44100
  const numSamples = Math.floor(sampleRate * durationSec)
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)

  // WAV header
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, numSamples * 2, true)

  // Generate sine wave with fade out
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const envelope = Math.max(0, 1 - t / durationSec) // linear fade
    const sample = Math.sin(2 * Math.PI * freq * t) * volume * envelope
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample * 32767)), true)
  }

  // Convert to base64
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return 'data:audio/wav;base64,' + btoa(binary)
}

// Pre-generate chime sounds
const CHIME_NEW_POST = generateChimeWav(880, 0.5, 0.8)
const CHIME_REPLY = generateChimeWav(1100, 0.5, 0.8)

function playChime(type: 'post' | 'reply' = 'post') {
  try {
    const audio = new Audio(type === 'reply' ? CHIME_REPLY : CHIME_NEW_POST)
    audio.volume = 1.0
    audio.play().catch(e => console.error('Audio play error:', e))
  } catch (e) {
    console.error('Chime error:', e)
  }
}

function speak(message: string) {
  if (!('speechSynthesis' in window)) return
  speechSynthesis.cancel()

  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(message)
    utterance.rate = 1.0
    utterance.volume = 1.0
    utterance.pitch = 1.0

    // Try to find a good English voice
    const voices = speechSynthesis.getVoices()
    const preferred = voices.find(v => v.lang === 'en-US' && v.localService) ||
                      voices.find(v => v.lang.startsWith('en') && v.localService) ||
                      voices.find(v => v.lang.startsWith('en'))
    if (preferred) utterance.voice = preferred

    utterance.onerror = (e) => console.error('Speech error:', e)
    speechSynthesis.speak(utterance)
  }, 600)
}

// Combined: play chime then speak
function notify(message: string, type: 'post' | 'reply' = 'post') {
  playChime(type)
  speak(message)
}

// Expose globally so user can test from browser console: window.testFixtralSound()
if (typeof window !== 'undefined') {
  (window as any).testFixtralSound = () => {
    notify('Test notification. 1 paid request in estoration.', 'post')
  }
}

// ─── Persistence helpers ─────────────────────────────────────────────

function getSeenPostIds(): Set<string> {
  try {
    const s = localStorage.getItem('seenPostIds')
    if (s) return new Set(JSON.parse(s))
  } catch {}
  return new Set()
}

function saveSeenPostIds(ids: Set<string>) {
  localStorage.setItem('seenPostIds', JSON.stringify([...ids].slice(-500)))
}

function getSeenReplyIds(): Set<string> {
  try {
    const s = localStorage.getItem('seenReplyIds')
    if (s) return new Set(JSON.parse(s))
  } catch {}
  return new Set()
}

function saveSeenReplyIds(ids: Set<string>) {
  localStorage.setItem('seenReplyIds', JSON.stringify([...ids].slice(-200)))
}

// ─── Provider Component ──────────────────────────────────────────────

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const seenPostIds = useRef<Set<string>>(new Set())
  const seenReplyIds = useRef<Set<string>>(new Set())
  const isFirstLoad = useRef(true)

  // Load persisted IDs on mount
  useEffect(() => {
    seenPostIds.current = getSeenPostIds()
    seenReplyIds.current = getSeenReplyIds()
  }, [])

  // Unlock audio: play a silent Audio on first click so browser allows future playback
  useEffect(() => {
    const unlock = () => {
      const silence = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=')
      silence.volume = 0.01
      silence.play().catch(() => {})
      // Preload speech voices
      if ('speechSynthesis' in window) speechSynthesis.getVoices()
      document.removeEventListener('click', unlock)
      document.removeEventListener('keydown', unlock)
    }
    document.addEventListener('click', unlock)
    document.addEventListener('keydown', unlock)
    if ('speechSynthesis' in window) speechSynthesis.getVoices()
    return () => {
      document.removeEventListener('click', unlock)
      document.removeEventListener('keydown', unlock)
    }
  }, [])

  // ─── Poll for new posts ──────────────────────────────────────────

  const checkNewPosts = useCallback(async () => {
    try {
      const subredditsParam = SUBREDDITS.join(',')
      const res = await fetch(`/api/reddit/posts?subreddits=${subredditsParam}`)
      const data = await res.json()
      if (!data.ok) return

      const posts: any[] = data.posts || []

      if (isFirstLoad.current) {
        // First load: just mark everything as seen, no notification
        posts.forEach(p => seenPostIds.current.add(p.id))
        saveSeenPostIds(seenPostIds.current)
        isFirstLoad.current = false
        return
      }

      // Find genuinely new posts
      const freshPosts = posts.filter(p => !seenPostIds.current.has(p.id))

      if (freshPosts.length > 0) {
        // Build voice message
        const grouped: Record<string, { paid: number; free: number }> = {}
        for (const p of freshPosts) {
          const sub = p.subreddit || 'unknown'
          if (!grouped[sub]) grouped[sub] = { paid: 0, free: 0 }
          if (p.isPaid) grouped[sub].paid++
          else grouped[sub].free++
        }

        const parts: string[] = []
        for (const [sub, counts] of Object.entries(grouped)) {
          if (counts.paid > 0) {
            parts.push(`${counts.paid} paid request${counts.paid > 1 ? 's' : ''} in ${sub}`)
          }
          if (counts.free > 0) {
            parts.push(`${counts.free} free request${counts.free > 1 ? 's' : ''} in ${sub}`)
          }
        }

        if (parts.length > 0) {
          notify(`New: ${parts.join('. ')}`, 'post')
        }

        // Mark as seen
        freshPosts.forEach(p => seenPostIds.current.add(p.id))
        saveSeenPostIds(seenPostIds.current)

        // Also notify the queue-view via a custom event so it can update its UI
        window.dispatchEvent(new CustomEvent('fixtral:newPosts', {
          detail: { postIds: freshPosts.map((p: any) => p.id) }
        }))
      }
    } catch (e) {
      console.error('Post check error:', e)
    }
  }, [])

  // ─── Poll for new replies ────────────────────────────────────────

  const checkReplies = useCallback(async () => {
    try {
      const res = await fetch(`/api/reddit/replies?username=${REDDIT_USERNAME}`)
      const data = await res.json()
      if (!data.ok) return

      // Broadcast commented post IDs so queue-view can show badges
      if (data.commentedPostIds?.length > 0) {
        window.dispatchEvent(new CustomEvent('fixtral:commentedPosts', {
          detail: { postIds: data.commentedPostIds }
        }))
      }

      const newReplies = (data.replies || []).filter(
        (r: any) => !seenReplyIds.current.has(r.replyId)
      )

      if (newReplies.length > 0) {
        const grouped: Record<string, string[]> = {}
        for (const r of newReplies) {
          if (!grouped[r.subreddit]) grouped[r.subreddit] = []
          grouped[r.subreddit].push(r.replyAuthor)
        }

        const parts: string[] = []
        for (const [sub, authors] of Object.entries(grouped)) {
          const unique = [...new Set(authors)]
          parts.push(`${unique.join(' and ')} replied to your comment in ${sub}`)
        }

        if (parts.length > 0) {
          notify(parts.join('. '), 'reply')
        }

        newReplies.forEach((r: any) => seenReplyIds.current.add(r.replyId))
        saveSeenReplyIds(seenReplyIds.current)
      }
    } catch (e) {
      console.error('Reply check error:', e)
    }
  }, [])

  // ─── Start polling on mount ──────────────────────────────────────

  useEffect(() => {
    // Initial checks
    checkNewPosts()
    checkReplies()

    // Set up intervals
    const postInterval = setInterval(checkNewPosts, FETCH_INTERVAL)
    const replyInterval = setInterval(checkReplies, REPLY_CHECK_INTERVAL)

    return () => {
      clearInterval(postInterval)
      clearInterval(replyInterval)
    }
  }, [checkNewPosts, checkReplies])

  return <>{children}</>
}
