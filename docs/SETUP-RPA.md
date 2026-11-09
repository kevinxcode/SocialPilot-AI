# Setting up RPA publishing (Threads and Facebook Page)

SocialPilot publishes by driving the Threads and Facebook websites in **your own Chrome profile**. It never logs in on your behalf and never sees your password.

## One-time setup

1. In the same Chrome profile, log in to **threads.com** and **facebook.com**.
2. On Facebook, **switch into your Page** (profile menu → your Page). The Page's own composer, "What's on your mind?", must be visible when you open the Page URL.
3. Go to **Dashboard → Social Accounts** and enter:
   - **Threads:** your profile URL, such as `https://www.threads.com/@cuciqu.pro`.
   - **Facebook:** the Page URL, such as `https://www.facebook.com/cuciqupro`, and the **exact Page name**.
4. Click **Check login**. A small automation window opens and then closes. A pass looks like this:
   - **Threads:** your own profile shows **Edit profile**.
   - **Facebook:** the Page shows its admin composer.
5. Click **Run dry run**. The composer opens and your text is typed in, but **Post is not clicked**. Look at the window, then close it.

## What happens when a post is published

1. The automation window opens your profile or Page and runs the login and identity checks. Facebook also confirms that the composer header shows your **Page name**. If any check fails, nothing is posted.
2. The images are attached and the program waits for their previews. Then the text is entered and checked character by character.
3. **Post** is clicked.
4. The profile or Page feed is reloaded until the post appears, for up to 90 seconds. Only then is the post marked **Published**, with its link.
5. If the result is unclear (the composer didn't close, or the post isn't visible yet), the status becomes **Verifying**. The next attempt searches the feed first and does not post again if it finds the post.

Retries: up to 3, after 2, 10 and 30 minutes. Posts on the same platform are kept at least 60 minutes apart; you can change this in Settings.

## When Meta changes the UI

All selectors live in two files:

- `src/services/publishing/rpa/selectors/threads.ts`
- `src/services/publishing/rpa/selectors/facebook.ts`

Each element has an ordered list of fallbacks, matched by CSS, aria-label or visible text, in English and Indonesian. Update the file, bump `version`, rebuild, and run the dry run again.

## Manual verification checklist (not yet done; needs your accounts)

- [ ] Threads Check login passes
- [ ] Threads dry run: text with emoji and line breaks appears exactly
- [ ] Threads real post with one image, confirmed and link saved
- [ ] Facebook Check login passes while acting as the Page
- [ ] Facebook Check login **fails** while acting as your personal profile
- [ ] Facebook dry run shows the Page name in the composer
- [ ] Facebook real post with one image, confirmed and link saved
- [ ] Turning off Wi-Fi during a post gives Verifying, then Published (no duplicate)
