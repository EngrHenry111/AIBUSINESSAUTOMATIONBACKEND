'use strict';

const { generateStructured, runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');

exports.generateContentPlan = async (req, res, next) => {
  try {
    const { topic, platforms = ['linkedin', 'twitter', 'instagram'], weeks = 2, industry, tone = 'professional' } = req.body;
    if (!topic) return next(new AppError('Topic is required.', 400));

    const prompt = `Create a social media content plan for a ${industry || 'business'} company.

Topic: ${topic}
Platforms: ${platforms.join(', ')}
Weeks: ${weeks}
Tone: ${tone}

Generate ${weeks * 5} post ideas (Mon-Fri for each week), each with platform, caption, hashtags, and best posting time.`;

    const schema = {
      posts: 'array of {day: string, platform: string, caption: string, hashtags: array, postingTime: string, contentType: string}',
      strategy: 'string - overall content strategy summary',
      tips: 'array of platform-specific tips',
    };

    const plan = await generateStructured(prompt, schema, 'social_agent');
    res.status(200).json({ success: true, data: plan });
  } catch (err) { next(err); }
};

exports.generateCaption = async (req, res, next) => {
  try {
    const { topic, platform, tone = 'professional', includeEmoji = true, includeHashtags = true } = req.body;
    if (!topic || !platform) return next(new AppError('Topic and platform are required.', 400));

    const prompt = `Write a compelling ${platform} post caption about: "${topic}"
Tone: ${tone}
Include emoji: ${includeEmoji}
Include hashtags: ${includeHashtags}
Platform character limits: Twitter=280, LinkedIn=3000, Instagram=2200

Write 3 variations from different angles (educational, promotional, engaging question).`;

    const content = await runAgent('social_agent', prompt);
    res.status(200).json({ success: true, data: { platform, topic, content } });
  } catch (err) { next(err); }
};

exports.generateHashtags = async (req, res, next) => {
  try {
    const { topic, platform, count = 15 } = req.body;
    if (!topic) return next(new AppError('Topic is required.', 400));

    const prompt = `Generate ${count} relevant hashtags for a ${platform || 'social media'} post about: "${topic}". Mix of high-volume, medium, and niche hashtags. Return as JSON array of strings.`;
    const result = await generateStructured(prompt, { hashtags: 'array of strings without # symbol' }, 'social_agent');
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
};

exports.generateCampaignIdeas = async (req, res, next) => {
  try {
    const { goal, budget, duration, targetAudience, industry } = req.body;
    const prompt = `Create social media campaign ideas for a ${industry || 'business'}.
Goal: ${goal}
Budget: ${budget || 'moderate'}
Duration: ${duration || '1 month'}
Target audience: ${targetAudience || 'business professionals'}

Provide 3 distinct campaign concepts with strategy, tactics, content themes, and KPIs.`;

    const campaign = await runAgent('social_agent', prompt);
    res.status(200).json({ success: true, data: { campaign } });
  } catch (err) { next(err); }
};
