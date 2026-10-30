import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { load } from "cheerio";
import { ApiError } from "./api.mjs";

export function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && [18, 19].includes(b)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
const proxyDomains = [
  "uniqlo.com",
  "uniqlo.cn",
  "hm.com",
  "zara.com",
  "nike.com",
  "adidas.com",
  "jd.com",
  "taobao.com",
  "tmall.com",
  "amazon.com",
  "fakestoreapi.com",
  "360buyimg.com",
  "alicdn.com",
  "image.uniqlo.com",
  "lp2.hm.com",
  "static.zara.net",
  "static.nike.com",
  "assets.adidas.com",
  "media-amazon.com",
  "ssl-images-amazon.com",
];
export async function validateURL(value, resolve = lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("请输入完整的商品或图片链接");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new ApiError("仅支持标准 HTTP / HTTPS 商品链接");
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    isIP(url.hostname.replace(/[\[\]]/g, "")) === 6
  )
    throw new ApiError("不支持本地或内网链接");
  let records;
  try {
    records = isIP(url.hostname)
      ? [{ address: url.hostname, family: 4 }]
      : await resolve(url.hostname, { all: true, family: 4 });
  } catch {
    throw new ApiError("无法访问此链接，请直接上传商品图片");
  }
  if (!records.length || records.some((r) => !isPublicIPv4(r.address)))
    throw new ApiError("不支持本地或内网链接");
  return { url, address: records[0].address };
}
async function limitedBody(response, max) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ApiError("商品文件过大，请上传压缩后的图片");
  }
  if (!response.body) throw new ApiError("商品页面没有内容");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new ApiError("商品文件过大，请上传压缩后的图片");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createProducts({ proxyRequest, resolve = lookup } = {}) {
  const fetchPublic = async (value, kind) => {
    let target = value;
    for (let hop = 0; hop < 4; hop++) {
      const { url, address } = await validateURL(target, resolve);
      // A corporate proxy performs its own DNS lookup; use a fixed retail/CDN
      // allowlist there. Direct requests instead pin the validated IPv4 address.
      if (
        proxyRequest &&
        !proxyDomains.some(
          (d) => url.hostname === d || url.hostname.endsWith(`.${d}`),
        )
      )
        throw new ApiError("此站点暂不支持链接解析，请上传商品图片");
      const agent = proxyRequest
        ? undefined
        : new Agent({
            connect: {
              lookup: (_host, _options, callback) => callback(null, address, 4),
            },
          });
      try {
        const response = await (proxyRequest || undiciFetch)(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            "User-Agent": "X-Mirror/0.1 (product preview)",
            Accept:
              kind === "image"
                ? "image/*"
                : "text/html,application/json,image/*",
          },
          ...(agent ? { dispatcher: agent } : {}),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new ApiError("商品页面跳转异常");
          target = new URL(location, url).href;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ApiError("商品页面暂时无法读取，请直接上传图片");
        }
        const type = (response.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const image = ["image/jpeg", "image/png", "image/webp"].includes(type);
        if (kind === "image" && !image) {
          await response.body?.cancel();
          throw new ApiError("链接没有返回 JPG、PNG 或 WebP 图片");
        }
        if (
          !image &&
          !["text/html", "application/json", "application/xhtml+xml"].includes(
            type,
          )
        ) {
          await response.body?.cancel();
          throw new ApiError("无法识别商品页面，请上传图片");
        }
        return {
          bytes: await limitedBody(
            response,
            image ? 10 * 1024 * 1024 : 2 * 1024 * 1024,
          ),
          type,
          url: url.href,
          image,
        };
      } finally {
        await agent?.close();
      }
    }
    throw new ApiError("商品页面跳转过多，请上传图片");
  };
  const image = async (url) => {
    const result = await fetchPublic(url, "image");
    return {
      dataUrl: `data:${result.type};base64,${result.bytes.toString("base64")}`,
    };
  };
  return {
    image,
    async resolve(url) {
      const page = await fetchPublic(url, "page");
      if (page.image)
        return {
          title: "链接中的服饰",
          sourceUrl: url,
          candidates: [page.url],
          ...(await image(page.url)),
        };
      const candidates = [];
      let title = "";
      const collect = (product) => {
        if (!product || typeof product !== "object") return;
        const productType = Array.isArray(product["@type"])
          ? product["@type"]
          : [product["@type"]];
        if (
          productType.includes("Product") ||
          (product.title && product.image)
        ) {
          title ||= String(product.name || product.title || "");
          const imgs = Array.isArray(product.image)
            ? product.image
            : [product.image];
          for (const item of imgs)
            if (item)
              candidates.push(typeof item === "string" ? item : item.url);
        }
        for (const value of Object.values(product))
          if (value && typeof value === "object") {
            for (const child of Array.isArray(value) ? value : [value])
              collect(child);
          }
      };
      if (page.type === "application/json") {
        try {
          collect(JSON.parse(page.bytes.toString("utf8")));
        } catch {
          throw new ApiError("无法读取商品信息");
        }
      } else {
        const $ = load(page.bytes.toString("utf8"));
        $('script[type="application/ld+json"]')
          .slice(0, 10)
          .each((_index, element) => {
            try {
              collect(JSON.parse($(element).text()));
            } catch {}
          });
        for (const selector of [
          'meta[property="og:image"]',
          'meta[name="twitter:image"]',
        ])
          $(selector).each((_i, e) => candidates.push($(e).attr("content")));
        title ||=
          $('meta[property="og:title"]').attr("content") || $("title").text();
      }
      const unique = [
        ...new Set(
          candidates
            .filter((c) => typeof c === "string")
            .map((c) => new URL(c, page.url).href),
        ),
      ].slice(0, 3);
      for (const candidate of unique) {
        try {
          return {
            title: title.trim().slice(0, 120) || "我的商品",
            sourceUrl: url,
            candidates: unique,
            ...(await image(candidate)),
          };
        } catch {
          /* Try next public candidate; never bypass validation. */
        }
      }
      throw new ApiError("未能读取商品主图，链接已保留，请上传商品图片");
    },
  };
}
