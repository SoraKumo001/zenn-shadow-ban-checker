import { serveDir } from "https://deno.land/std/http/file_server.ts";
import { semaphore } from "npm:@node-libraries/semaphore";

type ZennArticles = {
  articles: {
    slug: string;
  }[];
  next_page: number;
};

type ZennArticle = {
  article: {
    path: string;
    title: string;
    published_at: string;
    should_noindex: boolean;
  };
};

const escapeHtml = (str: string) => {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const localDate = (date: string) => {
  return new Date(date).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

const cache = await caches.open("zenn-shadow-ban-checker0");

const getArticles = async (username: string) => {
  console.info(`fetching articles of '${username}'`);
  const articles: ZennArticles["articles"] = [];
  let page = 1;
  do {
    const result: ZennArticles = await fetch(
      `https://zenn.dev/api/articles?username=${username}&page=${page}`
    ).then((res) => res.json());
    articles.push(...result.articles);
    page = result.next_page;
  } while (page !== null);
  const s = semaphore(5);
  const result = articles.map(({ slug }) => {
    const url = new URL(`https://zenn.dev/api/articles/${slug}`);
    return cache
      .match(url)
      .then((res) => {
        if (res) return res;
        s.acquire();
        return fetch(url)
          .then(async (res) => {
            await cache.put(url, res.clone());
            return res;
          })
          .finally(() => s.release());
      })
      .then((res) => res.json() as Promise<ZennArticle>)
      .then((res) => res.article);
  });
  return Promise.all(result);
};

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/images/")) {
    return serveDir(request, {
      fsRoot: "static",
      urlRoot: "",
      showDirListing: false,
      enableCors: true,
    });
  }

  const name = url.searchParams.get("name") ?? "";
  const result = !name
    ? []
    : await getArticles(name)
        .then((articles) =>
          articles.sort(
            (a, b) =>
              new Date(b.published_at).getTime() -
              new Date(a.published_at).getTime()
          )
        )
        .catch((e) => {
          console.error(e);
          return undefined;
        });

  const title = "Zenn's Shadow Ban checker";
  const description = "Check for shadow banning in Zenn.";
  const imageUrl = `${url.protocol}//${url.hostname}/images/ogp.png`;
  const html = [];
  html.push(
    `<html><head>`,
    `<title>Zenn's Shadow Ban checker</title>`,
    `<meta property="description" content="${description}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="${imageUrl}" />
        <meta name="twitter:card" content="summary" />`,
    `</head><body>`,
    `<form><input name='name'  placeholder='user-name' value='${name.replace(
      /'/g,
      "&#039;"
    )}'><input type='submit'></form><hr>`
  );
  if (result) {
    html.push("<ul style='list-style: none'>");
    for (const article of result) {
      html.push(
        `<li style="display:flex;gap:8px;"><span>${
          article.should_noindex ? "👻" : "🩷"
        }</span><span>${localDate(
          article.published_at
        )}</span><a href='https://zenn.dev${article.path}'>${escapeHtml(
          article.title
        )}</a></li>`
      );
    }
    html.push("</ul>");
  } else {
    html.push(
      "<p>The access limit on the Cloudflare side has been reached. Please allow some time.</p>"
    );
  }
  html.push("</ul></body></html>");
  return new Response(html.join(""), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
});
