import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://edlusjxoalqjkieugwce.supabase.co/rest/v1/'

const supabaseKey = 'sb_publishable_OfZfNYJUrtOqVUpv8bvU4Q_HyGHHIyx'

export const supabase = createClient(
    supabaseUrl,
    supabaseKey
)