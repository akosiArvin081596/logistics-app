// A sign-in from the login form on this page, taken once by whatever opens right after it. In memory on
// purpose: a reload starts it again as no, and so does a page already open, since neither is a sign-in.
let signedIn = false

export function noteSignIn() {
  signedIn = true
}

export function takeSignIn() {
  const taken = signedIn
  signedIn = false
  return taken
}
