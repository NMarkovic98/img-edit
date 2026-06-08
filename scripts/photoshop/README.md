# Reddit Drops Photoshop Action

Use `export-and-send-reddit-drops.jsx` as the final step in your Photoshop action.

Recommended action order:

1. Run your watermark steps.
2. Run `File > Scripts > Browse...`.
3. Select `scripts/photoshop/export-and-send-reddit-drops.jsx`.
4. Stop recording the action.

The active document name must be `Subreddit_postId`, which the queue Photoshop import already sets from the Reddit post.

The script exports PNG first. If that PNG is larger than 20MB, it deletes the
PNG and exports JPEG instead so the upload stays under the receiving script's
size limit.

Example output when PNG is small enough:

```text
/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/PhotoshopRequest_1tpfqz3.png
```

Example fallback output when PNG is over 20MB:

```text
/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/PhotoshopRequest_1tpfqz3.jpg
```

Remote upload:

```text
nmarkovic@192.168.0.26:~/reddit_drops/PhotoshopRequest_1tpfqz3.{png|jpg}
```

## Using Vercel with local Photoshop

Vercel cannot open Photoshop directly because it runs on a remote server. Start
the local helper on the Mac that has Photoshop installed:

```bash
npm run photoshop-helper
```

Then the Vercel queue button can call:

```text
http://127.0.0.1:3999/photoshop/open
```

The helper downloads the post images, saves them to `PSR Not Edited`, and opens
them in Photoshop as layers.

To keep the helper always running on this Mac, install it as a launchd user
service:

```bash
scripts/photoshop/install-local-helper-launchd.sh
```

Check it:

```bash
curl http://127.0.0.1:3999/health
```

View logs:

```bash
tail -f ~/Library/Logs/fixtral/photoshop-helper.out.log
tail -f ~/Library/Logs/fixtral/photoshop-helper.err.log
```

Remove the service:

```bash
scripts/photoshop/uninstall-local-helper-launchd.sh
```
