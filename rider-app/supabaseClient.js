// supabaseClient.js
import { createClient } from '@supabase/supabase-js';

// REPLACE THESE WITH YOUR ACTUAL KEYS from Supabase Dashboard
const SUPABASE_URL = 'https://qsxgnfigynaanjfsqmpu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzeGduZmlneW5hYW5qZnNxbXB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MjIwODUsImV4cCI6MjA4MDQ5ODA4NX0.iVz5cy0R2izas8Mi7sY1YArluHg5kRZ-1-KCAHgWvLI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);