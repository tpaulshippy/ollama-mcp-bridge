export const toolSchemas = {
  generate_image: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate"
      },
      guidance: {
        type: "number",
        enum: [1, 1.5, 2, 2.5, 3, 3.5],
        default: 1
      },
      aspect_ratio: {
        type: "string",
        enum: ["1:1", "4:5", "16:9"],
        default: "1:1"
      },
      megapixels: {
        type: "string",
        enum: ["1"],
        default: "1"
      },
      go_fast: {
        type: "boolean",
        default: true
      }
    },
    required: ["prompt"]
  },

  // Add schemas for other tools here
  send_email: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Email address of the recipient"
      },
      subject: {
        type: "string",
        description: "Subject line of the email"
      },
      body: {
        type: "string",
        description: "Content of the email"
      }
    },
    required: ["to", "subject", "body"]
  },

  brave_web_search: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (max 400 chars, 50 words)"
      },
      count: {
        type: "number",
        minimum: 1,
        maximum: 20,
        default: 10
      }
    },
    required: ["query"]
  }
}