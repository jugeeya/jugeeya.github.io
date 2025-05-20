# Rivals of Aether 2 Rankings

A beautiful web application that displays Rivals of Aether 2 rankings and ELO distribution. The app uses the Steam Community Web API to fetch leaderboard data and player information.

## Features

- Real-time ELO distribution visualization
- Player search functionality
- Automatic data refresh every 24 hours
- Manual refresh option
- Responsive design
- Beautiful dark theme UI

## How to Use

1. Open the application in your web browser
2. The ELO distribution graph will be displayed automatically
3. Use the search bar to find specific players
4. Click the "Refresh Data" button to manually update the rankings

## Deployment

This application can be easily deployed to GitHub Pages:

1. Create a new GitHub repository
2. Push all files to the repository
3. Go to repository Settings > Pages
4. Select the main branch as the source
5. The application will be available at `https://<your-username>.github.io/<repository-name>`

## Technical Details

- Built with vanilla JavaScript
- Uses Chart.js for data visualization
- Implements session storage for data caching
- Uses a CORS proxy to fetch data from Steam Community Web API
- No API key required
- No server required - runs entirely in the browser

## Data Storage

The application uses session storage to cache:
- ELO data for all players
- Player display names
- Last update timestamp

Data is automatically refreshed if it's older than 24 hours.

## Contributing

Feel free to submit issues and enhancement requests! 