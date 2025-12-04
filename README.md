`block_on_posts_only.js` is a simple script for the tampermonkey extension to block image auto generation for Grok Imagine on posts only. 

`block_everywhere_and_add_button.js` does the same as the other script but also replaces the auto generate on scroll behavior for the main imagine page with an explicit button to generate more images. (it is visually a bit buggy currently and results in the accumulation of empty image frames at the bottom of the page)

`image_downloader.js` adds download buttons so you never have to leave the main page and also provides an optional auto-download toggle.

it is usually required to refresh the page once to activate the script(s) after first navigating to the imagine page. you can confirm it's running in the console.

choose either `block_on_posts_only.js` or `block_everywhere_and_add_button.js`. `image_downloader.js` can be used in combination with either of the other scripts or on its own.
