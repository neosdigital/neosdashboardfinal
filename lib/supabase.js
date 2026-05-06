import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'sb_publishable_OfZfNYJUrtOqVUpv8bvU4Q_HyGHHIyx'

const supabaseKey = 'sb_secret_r5-4Hmjj5youu5qokojeDg_Sx9bhaAO'

export const supabase = createClient(
    supabaseUrl,
    supabaseKey
)