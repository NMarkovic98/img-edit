# Reddit Drops Photoshop Action

Use `export-and-send-reddit-drops.jsx` as the final step in your Photoshop action.

Recommended action order:

1. Run your watermark steps.
2. Run `File > Scripts > Browse...`.
3. Select `scripts/photoshop/export-and-send-reddit-drops.jsx`.
4. Stop recording the action.

The active document name must be `Subreddit_postId`, which the queue Photoshop import already sets from the Reddit post.

Example output:

```text
/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/PhotoshopRequest_1tpfqz3.png
```

Remote upload:

```text
nmarkovic@192.168.0.26:~/reddit_drops/PhotoshopRequest_1tpfqz3.png
```
