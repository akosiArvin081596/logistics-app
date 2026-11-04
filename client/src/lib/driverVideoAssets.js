// The walkthrough video's files (MP4, captions, poster) as Vite `?url` imports,
// kept apart from driverVideos.js so that file stays importable under plain Node.
import mp4 from '../assets/driver-videos/logisx-driver-app-walkthrough.mp4?url'
import vtt from '../assets/driver-videos/logisx-driver-app-walkthrough.en.vtt?url'
import poster from '../assets/driver-videos/logisx-driver-app-walkthrough-poster.jpg?url'

export const walkthrough = Object.freeze({ mp4, vtt, poster })
