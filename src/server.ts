import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { openai } from "@ai-sdk/openai";
import OpenAI from "openai";
import { generateObject } from "ai";
import {
  ProductSchema,
  cleanContent,
  getProductName,
  scrapeSearchResults,
  scrapeUrl,
  searchGoogle,
  selectBestImageWithVision,
  summarizeContent,
} from "./lib/functions";

puppeteerExtra.use(StealthPlugin());

dotenv.config();
const app = express();
const port = process.env.PORT || 3001;

// app.set("trust proxy", 1);

const openaiReal = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(",") || [],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(helmet());

// API Key middleware
const authenticateApiKey: express.RequestHandler = (req, res, next) => {
  const apiKey = req.get("X-API-Key");
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

// Apply authentication middleware to all /api routes
app.use("/api", authenticateApiKey);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

// Apply rate limiting to all requests
app.use(limiter);

// Add the new route before app.listen
// @ts-ignore
app.post("/api/product-scraper", async (req, res) => {
  try {
    // Add response headers
    // res.setHeader("Connection", "keep-alive");
    // res.setHeader("Keep-Alive", "timeout=300");

    const { url } = req.body;
    if (!url) {
      res.status(400).json({ error: "URL is required" });
      return;
    }

    const initialContent = await scrapeUrl(url);
    if (!initialContent?.content) {
      throw new Error("Failed to scrape initial URL");
    }

    const cleanedContent = await cleanContent(initialContent.content);
    const productName = await getProductName(cleanedContent);
    const searchResults = await searchGoogle(productName);
    const limitedResults = searchResults.searchResults.slice(0, 7);

    const { contents, images } = await scrapeSearchResults(
      limitedResults,
      productName
    );
    const bestImage = await selectBestImageWithVision(
      images,
      productName,
      openaiReal
    );

    const summarizedContents = await Promise.all(
      contents.map((result) => summarizeContent(result.content))
    );

    const combinedDetails = summarizedContents
      .filter((summary) => typeof summary === "string" && summary.length > 0)
      .join("\n\n");

    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: ProductSchema,
      prompt: `
        Generate comprehensive product information for ${productName}.
        Use this summarized content and specifications from multiple sources:

        Content:
        ${combinedDetails}

        Generate a detailed response including:
        1. Product name and description.(Description should be a detailed description of the product)
        2. Ratings and reviews. (Should be related to the product)
        3. Where to buy information. (Include the retailer, country, price and url)
        4. Technical specifications as an array of label-value pairs
        5. Frequently asked questions. (Should be technical questions or related to the product specifications)

        Important: Format specifications as an array of objects with label and value properties.
        Ensure all specifications are included and all information is factual.
      `,
    });

    object.image = bestImage;
    console.log("object", object);
    res.json(object);
  } catch (error) {
    console.error("Error in product scraper:", error);
    res.status(500).json({
      error: "Failed to scrape product information",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Add error handling middleware
// app.use((err: Error, req: Request, res: Response, next: Function) => {
//   console.error("Error:", err);
//   res.status(500).json({
//     error: "Internal Server Error",
//     message: process.env.NODE_ENV === "development" ? err.message : undefined,
//   });
// });

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
