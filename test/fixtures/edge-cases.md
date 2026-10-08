---
title: Edge cases
---

# ATX heading ##

Setext heading
==============

A paragraph that wraps
across two lines.{>>Existing inline comment<<}

{>>A standalone comment on the paragraph above<<}

- bullet one
  continued lazily
- bullet two
  - nested child
  - nested child two

    loose paragraph inside bullet two
- bullet three

1. ordered one
2. ordered two

> A quote
> over two lines

| Col A | Col B |
| --- | :---: |
| 1 | 2 |

```md
Literal {>>not a comment<<} inside a fence.
```

~~~
tilde fence
~~~

<div>
html block
</div>

***

Inline `code {>>not a comment<<}` span and a real one.{>>real<<}

Paragraph with {==highlighted==} words.

Hard break line  
next line.
